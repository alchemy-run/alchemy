#[tokio::main]
async fn main() -> anyhow::Result<()> {
	rust_actors::registry().start().await
}
