use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[tauri::command]
async fn tcp_print_escpos(host: String, port: u16, data: Vec<u8>) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let addr = (host.as_str(), port)
      .to_socket_addrs()
      .map_err(|e| format!("Unable to resolve host: {e}"))?
      .next()
      .ok_or("Unable to resolve host")?;

    let timeout = Duration::from_secs(3);
    let mut stream =
      TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("TCP connect failed: {e}"))?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_nodelay(true);

    stream
      .write_all(&data)
      .map_err(|e| format!("TCP write failed: {e}"))?;
    let _ = stream.flush();

    Ok(())
  })
  .await
  .map_err(|e| format!("Print task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![tcp_print_escpos])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
