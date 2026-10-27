//! Small JSON ABI for Expo native modules. All sockets, discovery and connection policy stay in Rust.
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
    _bridge: Bridge,
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
            let bridge = Bridge::start(manager.clone()).await?;
            let base_url = bridge.base_url.clone();
            *SESSION.lock().map_err(|_| "Native session lock failed")? = Some(Session {
                manager,
                _bridge: bridge,
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
