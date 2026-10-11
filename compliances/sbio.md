# SBIO: Separation of Business logic and I/O

Business logic never performs I/O directly. It states what it needs as a
trait (a *port*), receives an implementation of that trait from its caller,
and stays testable with no disk, network, clock, GPU or database present. The
code that talks to the outside world lives in *adapters*, and one place, the
*composition root*, decides which adapter each port gets.

## What counts as I/O

Anything whose result depends on, or changes, the world outside the process's
own memory:

- **Filesystem**: `std::fs`, `tokio::fs`, `File::open`, `read_to_string`,
  memory-mapped files, `std::path::Path::exists`/`metadata`.
- **Network**: `std::net`, `tokio::net`, `reqwest`, `hyper` clients, `ureq`,
  `tonic` channels, raw sockets.
- **Process**: `std::process::Command`, `tokio::process`, `std::process::exit`,
  signals.
- **Clock**: `Instant::now`, `SystemTime::now`, `chrono::Utc::now`/`Local::now`,
  `tokio::time::sleep`/`interval`, `std::thread::sleep`.
- **Environment and configuration**: `std::env::var`/`vars`/`args`,
  `dotenv`, reading a config file (`config.toml`, `.env`, YAML).
- **Randomness**: `rand::thread_rng`, `rand::random`, `OsRng`, `getrandom`.
- **GPU driver**: `cudarc`, `cuda_sys`/`cust`, `wgpu`, `metal`, `ash`
  (Vulkan), direct `cu*`/`cuda*` calls.
- **Database**: `sqlx`, `rusqlite`, `diesel`, `postgres`/`tokio_postgres`,
  `redis`, `mongodb`, `sled`, `redb`, `rocksdb`, `lmdb`.

Logging through a facade (`log::info!`, `tracing::debug!`) is not I/O for this
definition: the facade's sink is chosen at the edge.

## Core and edge

A **core** file holds business logic: rules, state machines, schedulers,
parsers, protocol logic, validation, pricing, routing decisions. Paths such as
`crates/*-core/`, `crates/core/`, `*/domain/`, `*/logic/`, `*/engine/` and the
`src/` of a library crate are core unless a marker below says otherwise.

An **edge** file is allowed to perform I/O. It is one of:

- an **adapter**: a file or crate whose path or crate name contains
  `adapter`, `-io`, `io/`, `host`, `infra`, `driver`, `-std`, `-fs`, `-net`,
  `-sqlite`, `-postgres`, `-cuda`, `-http`, or a file whose added code
  implements a port trait for one concrete technology
  (`impl Storage for SqliteStorage`);
- the **composition root**: `main.rs`, `src/bin/**`, and a `build.rs`;
- **tests and tooling**: `tests/**`, `benches/**`, `examples/**`, and code
  inside `#[cfg(test)]` modules or `#[test]` functions.

## How to judge a diff

1. Judge only added lines (`+`). Context lines show surroundings; removed
   lines cannot violate anything. Pre-existing I/O in context lines is not a
   violation of this change.
2. Decide for each file whether it is core or edge from its path and from the
   added code itself (see above). Only core files can violate these rules.
3. In a core file, look for these signals on added lines:
   - a call or `use` of any I/O API listed above (`io-in-core`, or
     `clock-in-core` for the clock, or `config-in-core` for environment and
     configuration);
   - a field, parameter or local of a concrete adapter type (a database pool,
     an HTTP client, a `File`, a CUDA context, `SqliteStorage`), or a call
     that constructs one (`::connect`, `::open`, `::new` on such a type),
     where a port trait should be (`concrete-adapter-in-core`);
   - a configuration value read deep inside the core instead of being passed
     in, explicitly validated, at startup (`config-in-core`);
   - a fallback that silently supplies an operational value when
     configuration is missing: `unwrap_or("8080")`, `unwrap_or(30)`,
     `unwrap_or_default()` on an env or config lookup, or a `Default` impl that
     invents a port, URL, path, timeout or limit (`implicit-default`).
     This applies in any file, core or edge, except tests.
4. Cite each offending construct once, with the line range of the added lines
   that contain it, the rule id that fits best, and the code itself as
   evidence. If a construct breaks two rules (an env read with a fallback in
   core), report it once per rule.
5. Do not flag: pure data types, traits that only declare ports, generic code
   bounded by a port trait, a core that calls methods on an injected port,
   logging facades, or I/O inside edge files.

## Rules

- `io-in-core`: a core file performs filesystem, network, process, randomness, GPU-driver or database I/O directly.
- `concrete-adapter-in-core`: a core type or function holds or constructs a concrete adapter instead of depending on a port trait.
- `config-in-core`: a core file reads environment variables, command-line arguments or configuration files itself instead of receiving validated configuration.
- `clock-in-core`: a core file reads the system clock or sleeps instead of using an injected clock port.
- `implicit-default`: code supplies a silent fallback for missing configuration (`unwrap_or`, `unwrap_or_default`, a defaulting `Default` impl) instead of requiring an explicit value or failing fast.

## Examples

Each example shows the non-compliant shape first, then the compliant one.

### E1: a file read in core becomes a `Store` port

Non-compliant, in `crates/billing-core/src/invoice.rs` (`io-in-core`):

```rust
pub fn load_rates(region: &str) -> Result<RateTable, BillingError> {
    let text = std::fs::read_to_string(format!("rates/{region}.json"))?;
    RateTable::parse(&text)
}
```

Compliant: the core names the need, an adapter crate meets it.

```rust
pub trait RateSource {
    fn rates(&self, region: &Region) -> Result<Vec<u8>, SourceError>;
}

pub fn load_rates<R: RateSource>(src: &R, region: &Region) -> Result<RateTable, BillingError> {
    RateTable::parse(&src.rates(region)?)
}
```

### E2: `Instant::now` in a scheduler becomes a `Clock` port

Non-compliant, in `crates/sched-core/src/queue.rs` (`clock-in-core`):

```rust
impl Queue {
    pub fn expire(&mut self) {
        let now = std::time::Instant::now();
        self.jobs.retain(|j| j.deadline > now);
    }
}
```

Compliant: time is an input, so a test can set it to any value.

```rust
pub trait Clock {
    fn monotonic_ms(&self) -> u64;
}

impl Queue {
    pub fn expire<C: Clock>(&mut self, clock: &C) {
        let now = clock.monotonic_ms();
        self.jobs.retain(|j| j.deadline_ms > now);
    }
}
```

### E3: a proxy tethered to a database (architecture level)

Non-compliant, in `crates/proxy-core/src/lib.rs`: the proxy's logic is welded
to one database (`concrete-adapter-in-core`, `io-in-core`).

```rust
pub struct Proxy {
    db: sqlx::PgPool,
}

impl Proxy {
    pub async fn forward(&self, req: Request) -> Result<Response, ProxyError> {
        let row: (Vec<u8>,) = sqlx::query_as("SELECT body FROM routes WHERE host = $1")
            .bind(req.host()).fetch_one(&self.db).await?;
        let route = Route::decode(&row.0)?;
        Ok(route.apply(req))
    }
}
```

Compliant: two ports state what each level fundamentally needs. Errors are
closed enums, and storage writes are one atomic batch.

```rust
// crates/proxy-core/src/ports.rs: the proxy's own requirement, and storage's.
pub trait Proxy {
    async fn forward(&self, req: Request) -> Result<Response, ProxyError>;
}
pub trait Storage {
    async fn get(&self, table: Table, key: &[u8]) -> Result<Option<Vec<u8>>, StorageError>;
    async fn commit(&self, batch: Batch) -> Result<Outcome, StorageError>;
}
pub enum StorageError { Unavailable, Conflict, Corrupt }

// crates/proxy-core/src/core.rs: pure logic, generic over the port.
pub struct ProxyCore<S: Storage> { storage: S }

impl<S: Storage> Proxy for ProxyCore<S> {
    async fn forward(&self, req: Request) -> Result<Response, ProxyError> {
        let bytes = self.storage.get(ROUTES, req.host().as_bytes()).await?
            .ok_or(ProxyError::NoRoute)?;
        Ok(Route::decode(&bytes)?.apply(req))
    }
}
```

The concrete adapter lives in its own crate, and only `main.rs` picks it, from
explicit configuration, failing fast on anything unknown:

```rust
// crates/proxy-store-postgres/src/lib.rs: `impl Storage for PgStorage { ... }`

// crates/proxy-bin/src/main.rs
let config = Config::from_env()?; // every field required, validated once
match config.storage.as_str() {
    "postgres" => serve(ProxyCore::new(PgStorage::connect(&config.db_url).await?)).await,
    "memory" => serve(ProxyCore::new(MemStorage::new())).await,
    other => Err(StartupError::UnknownStorage(other.to_owned())),
}
```

### E4: an implicit default becomes validated configuration

Non-compliant, in `crates/gateway-core/src/listen.rs`
(`config-in-core`, `implicit-default`):

```rust
pub fn listen_port() -> u16 {
    std::env::var("PORT").unwrap_or("8080".into()).parse().unwrap()
}
```

Compliant: configuration is parsed once at startup, every field required, and
the core receives the validated value.

```rust
pub struct GatewayConfig { pub port: u16 }

impl GatewayConfig {
    pub fn parse(vars: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let raw = vars.get("PORT").ok_or(ConfigError::Missing("PORT"))?;
        Ok(Self { port: raw.parse().map_err(|_| ConfigError::Invalid("PORT"))? })
    }
}

pub fn bind_address(config: &GatewayConfig) -> SocketAddr {
    SocketAddr::from(([0, 0, 0, 0], config.port))
}
```

## Not violations

- I/O in `tests/**`, `benches/**`, `examples/**`, `#[cfg(test)]` modules and
  `#[test]` functions, including test doubles that touch temp files.
- I/O inside an adapter crate or file that implements a port trait.
- `main.rs` (or `src/bin/**`) reading the environment, opening connections
  and constructing adapters to wire them into cores, provided a missing value
  is an error rather than a fallback.
- Pure data types, enums, `serde` derives, parsing of bytes already in
  memory, and arithmetic.
- Port trait declarations, and core code calling methods on an injected port.
- `log`/`tracing` macros.
