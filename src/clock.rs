//! `Instant`, with a stand-in for WebAssembly, where `std::time::Instant` panics.
//!
//! In the browser the solver has no clock: time limits never trigger (the page ends a
//! run by terminating its worker) and the timing statistics read zero.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;

#[cfg(target_arch = "wasm32")]
pub use fake::Instant;

#[cfg(target_arch = "wasm32")]
mod fake {
    use std::ops::{Add, Sub};
    use std::time::Duration;

    #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
    pub struct Instant;

    impl Instant {
        pub fn now() -> Instant {
            Instant
        }

        pub fn elapsed(&self) -> Duration {
            Duration::ZERO
        }

        pub fn duration_since(&self, _earlier: Instant) -> Duration {
            Duration::ZERO
        }
    }

    impl Add<Duration> for Instant {
        type Output = Instant;
        fn add(self, _: Duration) -> Instant {
            Instant
        }
    }

    impl Sub<Instant> for Instant {
        type Output = Duration;
        fn sub(self, _: Instant) -> Duration {
            Duration::ZERO
        }
    }
}
