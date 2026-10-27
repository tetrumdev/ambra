//! Server-only VB-CABLE discovery and per-process Windows routing.
//! The private policy interfaces are versioned and checked at runtime. Never set a
//! system default endpoint; unknown policy interfaces fail before Soloist can render.
use super::{native_error, unavailable};
use crate::soloist::Error;
use std::{ffi::c_void, mem::size_of};
use windows::{
    Wdk::System::SystemServices::RtlGetVersion,
    Win32::{
        Devices::FunctionDiscovery::{PKEY_Device_FriendlyName, PKEY_DeviceInterface_FriendlyName},
        Foundation::{CloseHandle, HANDLE, PROPERTYKEY, VARIANT_FALSE},
        Media::{Audio::*, KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM},
        System::{
            Com::{
                CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, STGM_READ, STGM_READWRITE,
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                    PropVariantClear, PropVariantToBoolean, PropVariantToStringAlloc,
                },
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::*,
            SystemInformation::OSVERSIONINFOW,
            Threading::{
                GetExitCodeProcess, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SET_QUOTA, PROCESS_TERMINATE, ResumeThread, THREAD_SUSPEND_RESUME,
            },
            Variant::{VT_BOOL, VT_EMPTY},
            WinRT::{RO_INIT_MULTITHREADED, RoGetActivationFactory, RoInitialize, RoUninitialize},
        },
        UI::Shell::PropertiesSystem::IPropertyStore,
    },
    core::{GUID, HRESULT, HSTRING, IInspectable_Vtbl, IUnknown_Vtbl, Interface, PCWSTR},
};

const LISTEN: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x24dbb0fc_9311_4b3d_9cf0_18ff155639d4),
    pid: 1,
};

fn cable_interface(name: &str) -> bool {
    // Pack45 exposes a device description and a distinct wave-interface name.
    // Windows may prefix a reinstalled device with its instance number.
    let name = name
        .split_once("- ")
        .filter(|(instance, _)| {
            !instance.is_empty() && instance.bytes().all(|c| c.is_ascii_digit())
        })
        .map_or(name, |(_, name)| name);
    matches!(name, "VB-Audio Virtual Cable" | "VB-Audio Point")
}

pub(super) struct Apartment;
impl Apartment {
    pub(super) fn enter() -> Result<Self, Error> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).map_err(native_error)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

pub(super) fn check_platform() -> Result<(), Error> {
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if !cfg!(target_arch = "x86_64")
        || unsafe { RtlGetVersion(&mut version).0 < 0 }
        || version.dwMajorVersion < 10
        || version.dwBuildNumber < 20_348
    {
        return Err(unavailable(
            "Soloist process capture requires x86-64 Windows build 20348 or newer.",
        ));
    }
    Ok(())
}

struct Property(PROPVARIANT);
impl Drop for Property {
    fn drop(&mut self) {
        unsafe {
            let _ = PropVariantClear(&mut self.0);
        }
    }
}
fn property(store: &IPropertyStore, key: &PROPERTYKEY) -> Result<Property, Error> {
    unsafe { store.GetValue(key).map(Property).map_err(native_error) }
}
fn text_property(store: &IPropertyStore, key: &PROPERTYKEY) -> Result<String, Error> {
    let value = property(store, key)?;
    unsafe {
        let string = PropVariantToStringAlloc(&value.0).map_err(native_error)?;
        let result = string
            .to_string()
            .map_err(|_| unavailable("Windows returned an invalid endpoint property string."));
        CoTaskMemFree(Some(string.0.cast()));
        result
    }
}
fn device_id(device: &IMMDevice) -> Result<String, Error> {
    unsafe {
        let id = device.GetId().map_err(native_error)?;
        let result = id
            .to_string()
            .map_err(|_| unavailable("Windows returned an invalid endpoint identity."));
        CoTaskMemFree(Some(id.0.cast()));
        result
    }
}

pub(super) struct Route {
    enumerator: IMMDeviceEnumerator,
    render: IMMDevice,
    capture: IMMDevice,
    id: String,
}
impl Route {
    pub(super) fn discover() -> Result<Self, Error> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(native_error)?;
            let find = |flow, prefix: &str| -> Result<IMMDevice, Error> {
                let endpoints = enumerator
                    .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                    .map_err(native_error)?;
                let mut found = None;
                for index in 0..endpoints.GetCount().map_err(native_error)? {
                    let device = endpoints.Item(index).map_err(native_error)?;
                    let store = device.OpenPropertyStore(STGM_READ).map_err(native_error)?;
                    let interface = text_property(&store, &PKEY_DeviceInterface_FriendlyName)?;
                    let name = text_property(&store, &PKEY_Device_FriendlyName)?;
                    if cable_interface(&interface) && name.starts_with(prefix) {
                        if found.is_some() {
                            return Err(unavailable(
                                "Multiple VB-CABLE endpoints match; keep one dedicated stereo CABLE Input/Output pair for Ambra Server.",
                            ));
                        }
                        found = Some(device);
                    }
                }
                found.ok_or_else(|| unavailable("Optional VB-CABLE driver is missing or inactive. Run `ambra-server spotify soloist driver setup` on this server; Spotify continues at High without it."))
            };
            let render = find(eRender, "CABLE Input (")?;
            let capture = find(eCapture, "CABLE Output (")?;
            let id = device_id(&render)?;
            Ok(Self {
                enumerator,
                render,
                capture,
                id,
            })
        }
    }

    pub(super) fn validate(&self) -> Result<(), Error> {
        unsafe {
            if self.render.GetState().map_err(native_error)? != DEVICE_STATE_ACTIVE
                || self.capture.GetState().map_err(native_error)? != DEVICE_STATE_ACTIVE
            {
                return Err(unavailable(
                    "The server's VB-CABLE endpoints are unavailable.",
                ));
            }
            let store = self
                .capture
                .OpenPropertyStore(STGM_READ)
                .map_err(native_error)?;
            let listen = property(&store, &LISTEN)?;
            if listen.0.Anonymous.Anonymous.vt != VT_EMPTY
                && PropVariantToBoolean(&listen.0)
                    .map_err(native_error)?
                    .as_bool()
            {
                return Err(unavailable(
                    "VB-CABLE has Listen to this device enabled. Run `ambra-server spotify soloist driver setup` to configure a silent server route.",
                ));
            }
            let client: IAudioClient = self
                .render
                .Activate(CLSCTX_ALL, None)
                .map_err(native_error)?;
            let format = client.GetMixFormat().map_err(native_error)?;
            if format.is_null() {
                return Err(unavailable("VB-CABLE returned no mix format."));
            }
            let wave = format.read_unaligned();
            let valid = wave.nSamplesPerSec == 44_100
                && wave.nChannels == 2
                && wave.wBitsPerSample == 32
                && wave.nBlockAlign == 8
                && (wave.wFormatTag == 3
                    || (wave.wFormatTag == 0xfffe && wave.cbSize == 22 && {
                        let extended = format.cast::<WAVEFORMATEXTENSIBLE>().read_unaligned();
                        let subformat = extended.SubFormat;
                        extended.Samples.wValidBitsPerSample >= 24
                            && extended.dwChannelMask == 3
                            && (subformat == KSDATAFORMAT_SUBTYPE_PCM
                                || subformat
                                    == GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71))
                    }));
            CoTaskMemFree(Some(format.cast()));
            if !valid {
                return Err(unavailable(
                    "VB-CABLE needs 44,100 Hz stereo with at least 24-bit precision. Run `ambra-server spotify soloist driver setup`; Ambra will not silently resample.",
                ));
            }
            Ok(())
        }
    }

    /// Called only after the server administrator consents to configuring this cable.
    pub(super) fn configure(&self) -> Result<(), Error> {
        unsafe {
            for endpoint in [&self.render, &self.capture] {
                let manager: IAudioSessionManager2 =
                    endpoint.Activate(CLSCTX_ALL, None).map_err(native_error)?;
                let sessions = manager.GetSessionEnumerator().map_err(native_error)?;
                for index in 0..sessions.GetCount().map_err(native_error)? {
                    if sessions
                        .GetSession(index)
                        .map_err(native_error)?
                        .GetState()
                        .map_err(native_error)?
                        == AudioSessionStateActive
                    {
                        return Err(unavailable(
                            "VB-CABLE is in use. Stop applications using the cable before configuring it for Ambra Server.",
                        ));
                    }
                }
            }
            let policy: DevicePolicy = CoCreateInstance(
                &GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9),
                None,
                CLSCTX_ALL,
            )
            .map_err(native_error)?;
            let mut format = WAVEFORMATEXTENSIBLE {
                Format: WAVEFORMATEX {
                    wFormatTag: 0xfffe,
                    nChannels: 2,
                    nSamplesPerSec: 44_100,
                    nAvgBytesPerSec: 352_800,
                    nBlockAlign: 8,
                    wBitsPerSample: 32,
                    cbSize: 22,
                },
                Samples: WAVEFORMATEXTENSIBLE_0 {
                    wValidBitsPerSample: 24,
                },
                dwChannelMask: 3,
                SubFormat: KSDATAFORMAT_SUBTYPE_PCM,
            };
            let id: Vec<_> = self.id.encode_utf16().chain(Some(0)).collect();
            (policy.vtable().set_format)(
                policy.as_raw(),
                PCWSTR(id.as_ptr()),
                &mut format.Format,
                std::ptr::null_mut(),
            )
            .ok()
            .map_err(native_error)?;
            let store = self
                .capture
                .OpenPropertyStore(STGM_READWRITE)
                .map_err(native_error)?;
            let disabled = Property(PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_BOOL,
                        Anonymous: PROPVARIANT_0_0_0 {
                            boolVal: VARIANT_FALSE,
                        },
                        ..Default::default()
                    }),
                },
            });
            store.SetValue(&LISTEN, &disabled.0).map_err(native_error)?;
            store.Commit().map_err(native_error)?;
        }
        self.validate()
    }

    pub(super) fn set_process(&self, pid: u32) -> Result<(), Error> {
        let policy = ProcessPolicy::open()?;
        let endpoint = HSTRING::from(format!(
            r"\\?\SWD#MMDEVAPI#{}#{{e6327cad-dcec-4949-ae8a-991e976a79d2}}",
            self.id
        ));
        for role in [eConsole, eMultimedia, eCommunications] {
            policy.set(pid, role, &endpoint)?;
        }
        Ok(())
    }

    /// Positive evidence of the owned PID on the cable, and no active physical route.
    pub(super) fn verify(&self, pid: u32, unity: bool) -> Result<bool, Error> {
        self.validate()?;
        unsafe {
            let endpoints = self
                .enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(native_error)?;
            let mut found = false;
            for index in 0..endpoints.GetCount().map_err(native_error)? {
                let endpoint = endpoints.Item(index).map_err(native_error)?;
                let manager: IAudioSessionManager2 =
                    endpoint.Activate(CLSCTX_ALL, None).map_err(native_error)?;
                let sessions = manager.GetSessionEnumerator().map_err(native_error)?;
                for index in 0..sessions.GetCount().map_err(native_error)? {
                    let session = sessions.GetSession(index).map_err(native_error)?;
                    if session.GetState().map_err(native_error)? != AudioSessionStateActive {
                        continue;
                    }
                    let control: IAudioSessionControl2 = session.cast().map_err(native_error)?;
                    let mut owner = 0;
                    let result = (control.vtable().GetProcessId)(control.as_raw(), &mut owner);
                    if owner != pid {
                        continue;
                    }
                    if result != HRESULT(0) || device_id(&endpoint)? != self.id {
                        return Err(unavailable(
                            "Soloist is not exclusively routed to the server's VB-CABLE endpoint.",
                        ));
                    }
                    if unity {
                        let volume: ISimpleAudioVolume = session.cast().map_err(native_error)?;
                        let channels: IChannelAudioVolume = session.cast().map_err(native_error)?;
                        if volume.GetMute().map_err(native_error)?.as_bool()
                            || volume.GetMasterVolume().map_err(native_error)? != 1.0
                        {
                            return Err(unavailable(
                                "Soloist's Windows audio session is muted or not at unity gain.",
                            ));
                        }
                        let count = channels.GetChannelCount().map_err(native_error)?;
                        if count != 2 {
                            return Err(unavailable("Soloist's Windows session is not stereo."));
                        }
                        for channel in 0..count {
                            if channels.GetChannelVolume(channel).map_err(native_error)? != 1.0 {
                                return Err(unavailable(
                                    "Soloist's Windows audio channel is not at unity gain.",
                                ));
                            }
                        }
                    }
                    found = true;
                }
            }
            Ok(found)
        }
    }
}

// Private Windows policy ABI. Only these verified interface families are called.
// Layout references: EarTrumpet's IAudioPolicyConfigFactory variants and IPolicyConfig.
windows::core::define_interface!(
    Policy21,
    ProcessPolicyVtable,
    0xab3d4648_e242_459f_b02f_541c70306324
);
windows::core::define_interface!(
    PolicyLegacy,
    ProcessPolicyVtable,
    0x2a59116d_6c4f_45e0_a74f_707e3fef9258
);
#[repr(C)]
pub struct ProcessPolicyVtable {
    base: IInspectable_Vtbl,
    unused: [usize; 19],
    set_endpoint:
        unsafe extern "system" fn(*mut c_void, u32, EDataFlow, ERole, *mut c_void) -> HRESULT,
}
pub(super) enum ProcessPolicy {
    Current(Policy21),
    Legacy(PolicyLegacy),
}
impl ProcessPolicy {
    pub(super) fn open() -> Result<Self, Error> {
        let name = HSTRING::from("Windows.Media.Internal.AudioPolicyConfig");
        unsafe {
            RoGetActivationFactory(&name).map(Self::Current)
                .or_else(|_| RoGetActivationFactory(&name).map(Self::Legacy))
                .map_err(|_| unavailable("This Windows build does not expose a compatible per-process audio routing interface; Spotify uses High."))
        }
    }
    fn set(&self, pid: u32, role: ERole, endpoint: &HSTRING) -> Result<(), Error> {
        let (raw, table) = match self {
            Self::Current(value) => (value.as_raw(), value.vtable()),
            Self::Legacy(value) => (value.as_raw(), value.vtable()),
        };
        unsafe {
            (table.set_endpoint)(raw, pid, eRender, role, std::mem::transmute_copy(endpoint))
                .ok()
                .map_err(native_error)
        }
    }
}
windows::core::define_interface!(
    DevicePolicy,
    DevicePolicyVtable,
    0xf8679f50_850a_41cf_9c72_430f290290c8
);
#[repr(C)]
pub struct DevicePolicyVtable {
    base: IUnknown_Vtbl,
    unused: [usize; 3],
    set_format: unsafe extern "system" fn(
        *mut c_void,
        PCWSTR,
        *mut WAVEFORMATEX,
        *mut WAVEFORMATEX,
    ) -> HRESULT,
    unused_after_format: [usize; 6],
    set_default: unsafe extern "system" fn(*mut c_void, PCWSTR, ERole) -> HRESULT,
}

pub(super) fn audio_defaults() -> Result<Vec<(i32, i32, String)>, Error> {
    let _apartment = Apartment::enter()?;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(native_error)?;
        let mut defaults = Vec::new();
        for flow in [eRender, eCapture] {
            for role in [eConsole, eMultimedia, eCommunications] {
                if let Ok(device) = enumerator.GetDefaultAudioEndpoint(flow, role) {
                    defaults.push((flow.0, role.0, device_id(&device)?));
                }
            }
        }
        Ok(defaults)
    }
}

pub(super) fn restore_audio_defaults(defaults: &[(i32, i32, String)]) -> Result<(), Error> {
    let _apartment = Apartment::enter()?;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(native_error)?;
        let policy: DevicePolicy = CoCreateInstance(
            &GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9),
            None,
            CLSCTX_ALL,
        )
        .map_err(native_error)?;
        for (flow, role, id) in defaults {
            let role = ERole(*role);
            let current = enumerator
                .GetDefaultAudioEndpoint(EDataFlow(*flow), role)
                .map_err(native_error)?;
            if device_id(&current)? == *id {
                continue;
            }
            let store = current.OpenPropertyStore(STGM_READ).map_err(native_error)?;
            if cable_interface(&text_property(&store, &PKEY_DeviceInterface_FriendlyName)?) {
                let id: Vec<_> = id.encode_utf16().chain(Some(0)).collect();
                (policy.vtable().set_default)(policy.as_raw(), PCWSTR(id.as_ptr()), role).ok()
                    .map_err(|_| unavailable("Could not restore the physical audio default after driver installation. Select the previous speaker output in Windows Sound settings."))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognizes_vendor_interfaces_without_accepting_physical_device_names() {
        for name in [
            "VB-Audio Virtual Cable",
            "VB-Audio Point",
            "2- VB-Audio Virtual Cable",
        ] {
            assert!(cable_interface(name));
        }
        for name in [
            "Speakers",
            "CABLE Input",
            "Realtek Audio",
            "Other VB-Audio Point",
            "2- Speakers",
        ] {
            assert!(!cable_interface(name));
        }
    }
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
pub(super) struct Target {
    _job: Handle,
    process: Handle,
}
impl Target {
    /// Soloist starts suspended. Confine it before any of its code can run. No helper
    /// process can escape the verified route, and server exit closes the kill-on-close job.
    pub(super) fn confine(pid: u32) -> Result<Self, Error> {
        unsafe {
            let job = Handle(CreateJobObjectW(None, None).map_err(native_error)?);
            let process = Handle(
                OpenProcess(
                    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    pid,
                )
                .map_err(native_error)?,
            );
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(native_error)?;
            AssignProcessToJobObject(job.0, process.0).map_err(native_error)?;
            Ok(Self { _job: job, process })
        }
    }
    pub(super) fn running(&self) -> Result<bool, Error> {
        let mut code = 0;
        unsafe {
            GetExitCodeProcess(self.process.0, &mut code).map_err(native_error)?;
        }
        Ok(code == 259)
    }
    pub(super) fn resume(&self, pid: u32) -> Result<(), Error> {
        unsafe {
            let snapshot =
                Handle(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(native_error)?);
            let mut thread = THREADENTRY32 {
                dwSize: size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            Thread32First(snapshot.0, &mut thread).map_err(native_error)?;
            loop {
                if thread.th32OwnerProcessID == pid {
                    let handle = Handle(
                        OpenThread(THREAD_SUSPEND_RESUME, false, thread.th32ThreadID)
                            .map_err(native_error)?,
                    );
                    if ResumeThread(handle.0) != 1 {
                        return Err(unavailable(
                            "Soloist did not have the expected suspended startup thread.",
                        ));
                    }
                    return Ok(());
                }
                if Thread32Next(snapshot.0, &mut thread).is_err() {
                    break;
                }
            }
            Err(unavailable(
                "Could not find Soloist's suspended startup thread.",
            ))
        }
    }
}
