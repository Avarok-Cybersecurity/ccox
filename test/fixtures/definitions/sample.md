# Sample compliance: no filesystem access in core

Test fixture for the CCOX unit and end-to-end tests. It is deliberately
small; the real definitions live in `compliances/`.

## Scope

Code under `crates/core/` is pure business logic. It must not touch the
filesystem, the network, the clock or the environment directly.

## Rules

- `io-in-core`: a core file reads or writes the filesystem, the network or
  the environment (for example `std::fs`, `std::net`, `std::env`).
- `clock-in-core`: a core file reads the system clock (for example
  `SystemTime::now()` or `Instant::now()`).

## Compliant

```rust
pub fn total(items: &[u32]) -> u32 { items.iter().sum() }
```
