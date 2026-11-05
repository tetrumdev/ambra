//! Small JSON ABI for Expo native modules. All sockets, discovery and connection policy stay in Rust.
mod imports;
mod login;
mod offline;
use ambra_net::{
    ConnectionManager, Identity, SelectedServer, bridge::Bridge, pairing::PairingPayload,
};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, c_char},
    sync::{Arc, Mutex, OnceLock},
};

struct Session {
    manager: Arc<ConnectionManager>,
    bridge: Bridge,
}
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("mobile Tokio runtime")
    })
}

async fn call(directory: &str, operation: &str, args: Value) -> ambra_net::Result<Value> {
    match operation {
        "open" => {
            // A pairing payload pins the key, whether enrolling or restoring a saved device.
            let payload =
                PairingPayload::decode(args["payload"].as_str().ok_or("Missing pairing link")?)?;
            let identity = Identity::load_or_create(
                &std::path::Path::new(directory).join("ambra-device-identity.key"),
            )?;
            let selected = SelectedServer {
                public_key: payload.public_key,
                local_addresses: payload.local_addresses,
                public_endpoint: payload.public_endpoint,
            };
            let token = args["token"].as_str().map(str::to_owned);
            let manager = ConnectionManager::new(identity, selected, token);
            manager.enable_roaming();
            // Songs are downloaded ahead into the app's own storage so a network change
            // never interrupts what is playing.
            let cache = std::path::Path::new(directory).join("media-cache");
            let bridge = Bridge::start_with_cache(manager.clone(), Some(cache)).await?;
            let base_url = bridge.base_url.clone();
            *SESSION.lock().map_err(|_| "Native session lock failed")? = Some(Session {
                manager,
                bridge,
            });
            Ok(json!({ "baseUrl": base_url }))
        }
        "status" => {
            let session = SESSION.lock().map_err(|_| "Native session lock failed")?;
            Ok(session
                .as_ref()
                .map(|s| serde_json::to_value(s.manager.status()))
                .transpose()?
                .unwrap_or(json!({ "state": "Offline" })))
        }
        "close" => {
            SESSION
                .lock()
                .map_err(|_| "Native session lock failed")?
                .take();
            Ok(Value::Null)
        }
        "resume" => {
            let manager = SESSION
                .lock()
                .map_err(|_| "Native session lock failed")?
                .as_ref()
                .map(|s| s.manager.clone())
                .ok_or("Native networking is not open")?;
            manager.connect().await?;
            Ok(serde_json::to_value(manager.status())?)
        }
        "network_changed" => {
            if let Some(session) = SESSION.lock().map_err(|_| "Native session lock failed")?.as_ref() {
                session.manager.network_changed();
            }
            Ok(Value::Null)
        }
        "prefetch" => {
            let path = args["path"].as_str().ok_or("Missing media path")?;
            if !path.starts_with("/api/") {
                return Err("Only server media can be prefetched".into());
            }
            if let Some(session) = SESSION.lock().map_err(|_| "Native session lock failed")?.as_ref() {
                session.bridge.prefetch(path);
            }
            Ok(Value::Null)
        }
        // Downloads on this phone: they open and play without any server connection.
        "offline_open" => Ok(json!({ "baseUrl": offline::open(directory).await?.base_url() })),
        "offline_list" => Ok(offline::open(directory).await?.list()),
        "offline_jobs" => Ok(offline::open(directory).await?.jobs()),
        "offline_remove" => {
            let ids = args["ids"]
                .as_array()
                .ok_or("Missing download IDs")?
                .iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect::<Vec<_>>();
            offline::open(directory).await?.remove(&ids)?;
            Ok(Value::Null)
        }
        "offline_download" => {
            let quality = args["quality"]
                .as_str()
                .map_or(Some(ambra_vault::Quality::Max), ambra_vault::Quality::parse)
                .ok_or("Unknown download quality")?;
            let provider = args["provider"].as_str().ok_or("Missing provider")?.to_owned();
            let track_id = args["providerTrackId"].as_str().ok_or("Missing track ID")?.to_owned();
            let manager = SESSION
                .lock()
                .map_err(|_| "Native session lock failed")?
                .as_ref()
                .map(|session| session.manager.clone())
                .ok_or("Connect to the server to download")?;
            let offline = offline::open(directory).await?;
            Ok(json!({ "id": offline.start(manager, provider, track_id, quality)? }))
        }
        // Service sign-in: the in-app browser's loopback redirect is taken here.
        "login_listen" => {
            login::listen(args["redirect"].as_str().ok_or("Missing sign-in redirect")?).await?;
            Ok(Value::Null)
        }
        "login_result" => Ok(json!({ "url": login::result() })),
        "login_stop" => {
            login::stop();
            Ok(Value::Null)
        }
        // A music file picked on this phone, into the server's permanent library.
        "import_file" => {
            let uri = args["uri"].as_str().ok_or("Missing file")?;
            let path = uri.strip_prefix("file://").unwrap_or(uri);
            let path = urlencoding::decode(path).map_err(|_| "Invalid file path")?.into_owned();
            let name = args["name"].as_str().unwrap_or("Unknown Track").to_owned();
            let manager = SESSION
                .lock()
                .map_err(|_| "Native session lock failed")?
                .as_ref()
                .map(|session| session.manager.clone())
                .ok_or("Connect to the server to import music")?;
            Ok(imports::import(&manager, std::path::Path::new(&path), &name).await?)
        }
        "discover" => Ok(serde_json::to_value(
            ambra_net::lan::discover(std::time::Duration::from_millis(750)).await?,
        )?),
        _ => Err("Unknown native network operation".into()),
    }
}

/// The caller owns the returned UTF-8 string and must free it exactly once.
/// Calls run on a native background queue; never call this blocking ABI on the UI thread.
/// # Safety
/// All pointers must be non-null, NUL-terminated UTF-8 strings valid for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ambra_mobile_call(
    directory: *const c_char,
    operation: *const c_char,
    args: *const c_char,
) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        if directory.is_null() || operation.is_null() || args.is_null() {
            return Err("Null native argument".to_owned());
        }
        // SAFETY: required by the C ABI contract, pointers are checked for null above.
        let (directory, operation, args) = unsafe {
            (
                CStr::from_ptr(directory),
                CStr::from_ptr(operation),
                CStr::from_ptr(args),
            )
        };
        let directory = directory
            .to_str()
            .map_err(|_| "Invalid directory encoding")?;
        let operation = operation
            .to_str()
            .map_err(|_| "Invalid operation encoding")?;
        let bytes = args.to_bytes();
        if bytes.len() > 16 * 1024 {
            return Err("Native arguments are too large".into());
        }
        let args = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        runtime()
            .block_on(call(directory, operation, args))
            .map_err(|e| e.to_string())
    });
    let response = match result {
        Ok(Ok(value)) => json!({ "ok": value }),
        Ok(Err(error)) => json!({ "error": error }),
        Err(_) => json!({ "error": "Native networking failed" }),
    };
    CString::new(response.to_string())
        .expect("JSON escapes NUL")
        .into_raw()
}
/// # Safety
/// `value` must be null or a live string returned by ambra_mobile_call, freed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ambra_mobile_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_ambranetwork_AmbraNetworkModule_nativeCall(
    mut env: jni::JNIEnv,
    _: jni::objects::JObject,
    directory: jni::objects::JString,
    operation: jni::objects::JString,
    args: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| {
        let directory: String = env.get_string(&directory)?.into();
        let operation: String = env.get_string(&operation)?.into();
        let args: String = env.get_string(&args)?.into();
        let directory =
            CString::new(directory).map_err(|_| jni::errors::Error::NullPtr("directory"))?;
        let operation =
            CString::new(operation).map_err(|_| jni::errors::Error::NullPtr("operation"))?;
        let args = CString::new(args).map_err(|_| jni::errors::Error::NullPtr("args"))?;
        let output =
            unsafe { ambra_mobile_call(directory.as_ptr(), operation.as_ptr(), args.as_ptr()) };
        let text = unsafe { CStr::from_ptr(output) }
            .to_string_lossy()
            .into_owned();
        unsafe {
            ambra_mobile_free(output);
        }
        env.new_string(text).map(|s| s.into_raw())
    })();
    result.unwrap_or(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ffi_reports_errors_and_frees_results() {
        let directory = CString::new("/unused").unwrap();
        let operation = CString::new("unknown").unwrap();
        let args = CString::new("{}").unwrap();
        let result =
            unsafe { ambra_mobile_call(directory.as_ptr(), operation.as_ptr(), args.as_ptr()) };
        let value: Value =
            serde_json::from_slice(unsafe { CStr::from_ptr(result) }.to_bytes()).unwrap();
        assert!(value["error"].as_str().unwrap().contains("Unknown native"));
        unsafe {
            ambra_mobile_free(result);
        }
    }
}
