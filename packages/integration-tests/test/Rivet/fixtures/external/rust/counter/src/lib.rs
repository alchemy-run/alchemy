//! Rivet's Rust quickstart Actor, deployed as a Rust Durable Object from a
//! member of a Cargo workspace. The `double` feature doubles each increment.
use std::sync::Arc;

use async_trait::async_trait;
use rivetkit::prelude::*;
use rivetkit::{BindParam, ColumnValue};
use serde::{Deserialize, Serialize};

pub struct Counter;

#[derive(Serialize, Deserialize)]
pub struct Increment {
	pub amount: i64,
}

impl Action for Increment {
	type Output = i64;

	const NAME: &'static str = "increment";
}

#[derive(Serialize, Deserialize)]
pub struct NewCount {
	pub count: i64,
}

impl Event for NewCount {
	const NAME: &'static str = "newCount";
}

#[async_trait]
impl Actor for Counter {
	type Input = ();
	type Actions = (Increment,);
	type Events = (NewCount,);
	type ConnParams = ();
	type Action = action::Raw;

	async fn create(ctx: &Ctx<Self>) -> Result<Self> {
		ctx.sql()
			.exec(
				"CREATE TABLE IF NOT EXISTS counter (
					id INTEGER PRIMARY KEY,
					count INTEGER NOT NULL
				);
				INSERT OR IGNORE INTO counter (id, count) VALUES (0, 0);",
			)
			.await?;
		Ok(Self)
	}
}

impl Handler<Increment> for Counter {
	async fn handle(self: Arc<Self>, ctx: Ctx<Self>, action: Increment) -> Result<i64> {
		let result = ctx
			.sql()
			.execute(
				"UPDATE counter SET count = count + ? WHERE id = 0 RETURNING count",
				Some(vec![BindParam::Integer(if cfg!(feature = "double") {
					action.amount * 2
				} else {
					action.amount
				})]),
			)
			.await?;
		let count = match result.rows.first().and_then(|row| row.first()) {
			Some(ColumnValue::Integer(count)) => *count,
			other => return Err(anyhow!("expected integer count, got {other:?}")),
		};
		ctx.emit(NewCount { count })?;
		Ok(count)
	}
}

pub fn registry() -> Registry {
	let mut registry = Registry::new();
	registry.register_actor::<Counter>("counter");
	registry
}
