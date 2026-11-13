//! Safe ownership around Tailcat C ABI v1. Blocking calls never run on Tokio workers.
use crate::Result;
use std::{
    ffi::{CStr, CString, c_char, c_void},
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

unsafe extern "C" {
    fn tc_abi_version() -> u32;
    fn tc_token_new(ns: i64, out: *mut u64, error: *mut *mut c_char) -> i32;
    fn tc_token_cancel(token: u64, error: *mut *mut c_char) -> i32;
    fn tc_close(handle: u64, error: *mut *mut c_char) -> i32;
    fn tc_free(value: *mut c_void);
    fn tc_key_generate(out: *mut *mut c_char, error: *mut *mut c_char) -> i32;
    fn tc_client_new(config: *const c_char, out: *mut u64, error: *mut *mut c_char) -> i32;
    fn tc_server_new(config: *const c_char, out: *mut u64, error: *mut *mut c_char) -> i32;
    fn tc_client_dial(
        client: u64,
        token: u64,
        port: u16,
        network: i32,
        out: *mut u64,
        error: *mut *mut c_char,
    ) -> i32;
    fn tc_server_listen(
        server: u64,
        token: u64,
        port: u16,
        network: i32,
        out: *mut u64,
        error: *mut *mut c_char,
    ) -> i32;
    fn tc_listener_accept(listener: u64, token: u64, out: *mut u64, error: *mut *mut c_char)
    -> i32;
    fn tc_info(handle: u64, token: u64, out: *mut *mut c_char, error: *mut *mut c_char) -> i32;
    fn tc_client_disco_ping(
        client: u64,
        token: u64,
        out: *mut *mut c_char,
        error: *mut *mut c_char,
    ) -> i32;
    fn tc_conn_read(
        connection: u64,
        token: u64,
        buffer: *mut c_void,
        size: usize,
        count: *mut usize,
        error: *mut *mut c_char,
    ) -> i32;
    fn tc_conn_write(
        connection: u64,
        token: u64,
        buffer: *const c_void,
        size: usize,
        count: *mut usize,
        error: *mut *mut c_char,
    ) -> i32;
    fn tc_conn_close_write(connection: u64, token: u64, error: *mut *mut c_char) -> i32;
}
fn check(code: i32) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("Tailcat operation failed (ABI status {code})").into())
    }
}
// Error text from native code is intentionally discarded: input errors may contain secrets.
const NO_ERROR: *mut *mut c_char = std::ptr::null_mut();
pub struct Resource(u64);
impl Drop for Resource {
    fn drop(&mut self) {
        close_later(self.0);
    }
}
fn close_later(id: u64) {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn_blocking(move || unsafe {
            tc_close(id, NO_ERROR);
        });
    } else {
        std::thread::spawn(move || unsafe {
            tc_close(id, NO_ERROR);
        });
    }
}
struct Token(u64);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            tc_close(self.0, NO_ERROR);
        }
    }
}
struct Cancel(Arc<Token>);
impl Drop for Cancel {
    fn drop(&mut self) {
        unsafe {
            tc_token_cancel(self.0.0, NO_ERROR);
        }
    }
}
async fn call<T: Send + 'static>(
    seconds: u64,
    operation: impl FnOnce(u64) -> Result<T> + Send + 'static,
) -> Result<T> {
    let mut id = 0;
    check(unsafe { tc_token_new((seconds * 1_000_000_000) as i64, &mut id, NO_ERROR) })?;
    let token = Arc::new(Token(id));
    let _cancel = Cancel(token.clone());
    tokio::task::spawn_blocking(move || {
        let _token = token;
        operation(id)
    })
    .await?
}
unsafe fn string(operation: impl FnOnce(*mut *mut c_char) -> i32) -> Result<String> {
    let mut out = std::ptr::null_mut();
    let code = operation(&mut out);
    let value = if out.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned()
    };
    unsafe {
        tc_free(out.cast());
    }
    check(code)?;
    Ok(value)
}
pub async fn keys() -> Result<String> {
    call(5, |_| unsafe {
        string(|out| tc_key_generate(out, NO_ERROR))
    })
    .await
}
impl Resource {
    pub async fn new(config: String, server: bool) -> Result<Arc<Self>> {
        call(5, move |_| {
            if unsafe { tc_abi_version() } != 1 {
                return Err("Unsupported Tailcat ABI".into());
            }
            let config = CString::new(config)?;
            let mut id = 0;
            check(unsafe {
                if server {
                    tc_server_new(config.as_ptr(), &mut id, NO_ERROR)
                } else {
                    tc_client_new(config.as_ptr(), &mut id, NO_ERROR)
                }
            })?;
            Ok(Arc::new(Self(id)))
        })
        .await
    }
    pub async fn listen(self: &Arc<Self>) -> Result<Arc<Self>> {
        let owner = self.clone();
        call(30, move |token| {
            let mut id = 0;
            check(unsafe { tc_server_listen(owner.0, token, super::PORT, 1, &mut id, NO_ERROR) })?;
            Ok(Arc::new(Self(id)))
        })
        .await
    }
    pub async fn dial(self: &Arc<Self>) -> Result<NativeIo> {
        let owner = self.clone();
        let connection = call(25, move |token| {
            let mut id = 0;
            check(unsafe { tc_client_dial(owner.0, token, super::PORT, 1, &mut id, NO_ERROR) })?;
            Ok(Arc::new(Self(id)))
        })
        .await?;
        Ok(NativeIo::new(connection, self.clone()))
    }
    pub async fn accept(self: &Arc<Self>, owner: Arc<Self>) -> Result<NativeIo> {
        let listener = self.clone();
        let connection = call(3600, move |token| {
            let mut id = 0;
            check(unsafe { tc_listener_accept(listener.0, token, &mut id, NO_ERROR) })?;
            Ok(Arc::new(Self(id)))
        })
        .await?;
        Ok(NativeIo::new(connection, owner))
    }
    pub async fn info(self: &Arc<Self>) -> Result<serde_json::Value> {
        let owner = self.clone();
        let text = call(5, move |token| unsafe {
            string(|out| tc_info(owner.0, token, out, NO_ERROR))
        })
        .await?;
        Ok(serde_json::from_str(&text)?)
    }
    pub async fn path(self: &Arc<Self>) -> Result<serde_json::Value> {
        let owner = self.clone();
        let text = call(5, move |token| unsafe {
            string(|out| tc_client_disco_ping(owner.0, token, out, NO_ERROR))
        })
        .await?;
        Ok(serde_json::from_str(&text)?)
    }
    pub async fn close(self: &Arc<Self>) {
        let owner = self.clone();
        let _ = tokio::task::spawn_blocking(move || unsafe {
            tc_close(owner.0, NO_ERROR);
        })
        .await;
    }
}

pub struct NativeIo {
    io: tokio::io::DuplexStream,
    connection: Arc<Resource>,
    _owner: Arc<Resource>,
}
impl NativeIo {
    fn new(connection: Arc<Resource>, owner: Arc<Resource>) -> Self {
        let (io, pipe) = tokio::io::duplex(64 * 1024);
        let (mut read, mut write) = tokio::io::split(pipe);
        let runtime = tokio::runtime::Handle::current();
        let download = connection.clone();
        let down_runtime = runtime.clone();
        tokio::task::spawn_blocking(move || {
            let mut buffer = [0u8; 32 * 1024];
            loop {
                let mut n = 0;
                let code = unsafe {
                    tc_conn_read(
                        download.0,
                        0,
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                        &mut n,
                        NO_ERROR,
                    )
                };
                if n > 0
                    && down_runtime
                        .block_on(write.write_all(&buffer[..n]))
                        .is_err()
                {
                    break;
                }
                if code != 0 || n == 0 {
                    break;
                }
            }
            let _ = down_runtime.block_on(write.shutdown());
        });
        let upload = connection.clone();
        tokio::task::spawn_blocking(move || {
            let mut buffer = [0u8; 32 * 1024];
            while let Ok(n) = runtime.block_on(read.read(&mut buffer)) {
                if n == 0 {
                    break;
                }
                let mut offset = 0;
                while offset < n {
                    let mut sent = 0;
                    let code = unsafe {
                        tc_conn_write(
                            upload.0,
                            0,
                            buffer[offset..n].as_ptr().cast(),
                            n - offset,
                            &mut sent,
                            NO_ERROR,
                        )
                    };
                    offset += sent;
                    if code != 0 || sent == 0 {
                        return;
                    }
                }
            }
            unsafe {
                tc_conn_close_write(upload.0, 0, NO_ERROR);
            }
        });
        Self {
            io,
            connection,
            _owner: owner,
        }
    }
}
impl Drop for NativeIo {
    fn drop(&mut self) {
        close_later(self.connection.0);
    }
}
impl tokio::io::AsyncRead for NativeIo {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_read(cx, buf)
    }
}
impl tokio::io::AsyncWrite for NativeIo {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_shutdown(cx)
    }
}
