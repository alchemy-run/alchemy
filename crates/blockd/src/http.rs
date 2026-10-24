//! Just enough HTTP/1.1 for the daemon's JSON API: requests with a
//! `Content-Length` body, kept-alive connections, one thread per
//! connection. Its callers are a Durable Object through a host's port
//! proxy, or an orchestrator on the same network: nothing else.

use anyhow::{Context, Result, bail};
use std::io::{BufRead, BufReader, Read, Write};

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

pub struct Response {
    pub status: u16,
    pub body: serde_json::Value,
}

impl Response {
    pub fn ok(body: serde_json::Value) -> Self {
        Self { status: 200, body }
    }

    pub fn error(status: u16, message: impl std::fmt::Display) -> Self {
        Self {
            status,
            body: serde_json::json!({ "ok": false, "error": message.to_string() }),
        }
    }
}

const MAX_BODY: usize = 64 << 20;

/// Reads one request; `None` when the peer closed the connection.
pub fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        bail!("bad request line {line:?}");
    };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (key.to_string(), value.to_string())
        })
        .collect();
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            bail!("the connection closed mid-request");
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let mut request = Request {
        method: method.to_string(),
        path: path.to_string(),
        query,
        headers,
        body: Vec::new(),
    };
    if request
        .header("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        request.body = read_chunked(reader)?;
    } else if let Some(length) = request.header("content-length") {
        let length: usize = length.parse().context("content-length")?;
        if length > MAX_BODY {
            bail!("a {length}-byte body is too large");
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body)?;
        request.body = body;
    }
    Ok(Some(request))
}

fn read_chunked(reader: &mut impl BufRead) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let mut size = String::new();
        reader.read_line(&mut size)?;
        let size = usize::from_str_radix(size.trim().split(';').next().unwrap_or(""), 16)
            .context("chunk size")?;
        if body.len() + size > MAX_BODY {
            bail!("the body is too large");
        }
        let mut chunk = vec![0; size + 2];
        reader.read_exact(&mut chunk)?;
        body.extend_from_slice(&chunk[..size]);
        if size == 0 {
            return Ok(body);
        }
    }
}

pub fn write_response(writer: &mut impl Write, response: &Response) -> Result<()> {
    let body = response.body.to_string();
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Error",
    };
    write!(
        writer,
        "HTTP/1.1 {} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        response.status,
        body.len()
    )?;
    writer.flush()?;
    Ok(())
}

/// Serves connections from `listener` until the process exits.
pub fn serve<S, L>(listener: L, handle: std::sync::Arc<dyn Fn(Request) -> Response + Send + Sync>)
where
    L: Iterator<Item = std::io::Result<S>>,
    S: Read + Write + Send + 'static + TryClone,
{
    for stream in listener {
        let Ok(stream) = stream else { continue };
        let handle = handle.clone();
        let _ = std::thread::Builder::new()
            .name("blockd-http".into())
            .spawn(move || {
                let Ok(mut writer) = stream.try_clone_stream() else { return };
                let mut reader = BufReader::new(stream);
                loop {
                    let request = match read_request(&mut reader) {
                        Ok(Some(request)) => request,
                        Ok(None) => return,
                        Err(e) => {
                            let _ = write_response(&mut writer, &Response::error(400, format!("{e:#}")));
                            return;
                        }
                    };
                    let close = request
                        .header("connection")
                        .is_some_and(|value| value.eq_ignore_ascii_case("close"));
                    let response = handle(request);
                    if write_response(&mut writer, &response).is_err() || close {
                        return;
                    }
                }
            });
    }
}

/// A stream that can be split into a reader and a writer.
pub trait TryClone: Sized {
    fn try_clone_stream(&self) -> std::io::Result<Self>;
}

impl TryClone for std::net::TcpStream {
    fn try_clone_stream(&self) -> std::io::Result<Self> {
        self.try_clone()
    }
}

impl TryClone for std::os::unix::net::UnixStream {
    fn try_clone_stream(&self) -> std::io::Result<Self> {
        self.try_clone()
    }
}

/// One request to a daemon at `address` (`host:port`, or a socket path),
/// for `blockd request` and tests.
pub fn request(
    address: &str,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<(u16, String)> {
    let mut stream: Box<dyn ReadWrite> = if address.starts_with('/') {
        Box::new(std::os::unix::net::UnixStream::connect(address)?)
    } else {
        Box::new(std::net::TcpStream::connect(address)?)
    };
    let body = body.unwrap_or("");
    let auth = token.map(|t| format!("authorization: Bearer {t}\r\n")).unwrap_or_default();
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nhost: blockd\r\nconnection: close\r\n{auth}content-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )?;
    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader.read_line(&mut status)?;
    let code: u16 = status
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .with_context(|| format!("bad status line {status:?}"))?;
    let mut length = None;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let mut reply = Vec::new();
    match length {
        Some(n) => {
            reply.resize(n, 0);
            reader.read_exact(&mut reply)?;
        }
        None => {
            reader.read_to_end(&mut reply)?;
        }
    }
    Ok((code, String::from_utf8_lossy(&reply).into_owned()))
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}
