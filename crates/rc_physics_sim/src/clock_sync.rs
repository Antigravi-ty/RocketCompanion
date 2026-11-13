//! RTT jitter smoothing, lead/downlink tick computation, and physical clock pacing filter.

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ClockSyncStatePod {
    pub smoothed_rtt_ms: f32,
    pub rtt_jitter_ms: f32,
    pub clock_offset_ms: f32,
    pub lead_ticks: i32,
    pub downlink_ticks: i32,
    pub target_delta_ticks: i32,
    pub pacing_rate_hz: f32,
    pub drift_ticks: f32,
    pub sample_count: u32,
}

impl Default for ClockSyncStatePod {
    fn default() -> Self {
        Self {
            smoothed_rtt_ms: 0.0,
            rtt_jitter_ms: 0.0,
            clock_offset_ms: 0.0,
            lead_ticks: 3,
            downlink_ticks: 1,
            target_delta_ticks: 4,
            pacing_rate_hz: 120.0,
            drift_ticks: 0.0,
            sample_count: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ClockSyncFilter {
    pub state: ClockSyncStatePod,
}

impl ClockSyncFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.state = ClockSyncStatePod::default();
    }

    pub fn push_rtt_sample(&mut self, rtt_ms: f32, jitter_hint_ms: f32) {
        if !rtt_ms.is_finite() || rtt_ms < 0.0 {
            return;
        }
        let clamped_rtt = rtt_ms.clamp(0.0, 2000.0);
        let safe_jitter_hint = if jitter_hint_ms.is_finite() && jitter_hint_ms >= 0.0 {
            jitter_hint_ms.clamp(0.0, 500.0)
        } else {
            0.0
        };

        if self.state.sample_count == 0 {
            self.state.smoothed_rtt_ms = clamped_rtt;
            self.state.rtt_jitter_ms = safe_jitter_hint;
        } else {
            let delta = (clamped_rtt - self.state.smoothed_rtt_ms).abs();
            // RFC 3550-style EWMA jitter + asymmetric RTT smoothing (faster rise, gentler decay)
            let rtt_alpha = if clamped_rtt > self.state.smoothed_rtt_ms {
                0.25
            } else {
                0.125
            };
            self.state.smoothed_rtt_ms += (clamped_rtt - self.state.smoothed_rtt_ms) * rtt_alpha;
            let jitter_target = delta.max(safe_jitter_hint);
            self.state.rtt_jitter_ms += (jitter_target - self.state.rtt_jitter_ms) * 0.125;
        }
        self.state.sample_count = self.state.sample_count.saturating_add(1);
    }

    pub fn evaluate_pacing(
        &mut self,
        client_tick: i32,
        server_tick: i32,
        input_buffer_target: i32,
        max_lead_ticks: i32,
        tick_dt_ms: f32,
    ) -> i32 {
        let safe_dt = if tick_dt_ms.is_finite() && tick_dt_ms > 0.1 {
            tick_dt_ms
        } else {
            1000.0 / 120.0
        };
        let safe_target_buf = input_buffer_target.clamp(1, 24);
        let safe_max_lead = max_lead_ticks.clamp(4, 120);

        let one_way_ms = self.state.smoothed_rtt_ms * 0.5;
        let jitter_margin_ms = self.state.rtt_jitter_ms * 1.5;

        let raw_lead = ((one_way_ms + jitter_margin_ms) / safe_dt).ceil() as i32 + safe_target_buf;
        let lead_ticks = raw_lead.clamp(safe_target_buf, safe_max_lead);
        let downlink_ticks = (one_way_ms / safe_dt).ceil().max(1.0) as i32;
        let target_delta_ticks = lead_ticks + downlink_ticks;

        let current_delta = client_tick - server_tick;
        let raw_drift = (target_delta_ticks - current_delta) as f32;
        self.state.drift_ticks += (raw_drift - self.state.drift_ticks) * 0.2;
        self.state.clock_offset_ms = self.state.drift_ticks * safe_dt;

        let base_rate = 1000.0 / safe_dt;
        let rate_adjust = (self.state.drift_ticks * 0.75).clamp(-6.0, 6.0);
        self.state.lead_ticks = lead_ticks;
        self.state.downlink_ticks = downlink_ticks;
        self.state.target_delta_ticks = target_delta_ticks;
        self.state.pacing_rate_hz = (base_rate + rate_adjust).clamp(base_rate * 0.9, base_rate * 1.1);

        target_delta_ticks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtt_and_jitter_smooth_converges_and_bounds() {
        let mut filter = ClockSyncFilter::new();
        filter.push_rtt_sample(40.0, 2.0);
        assert!((filter.state.smoothed_rtt_ms - 40.0).abs() < 1e-4);
        for _ in 0..20 {
            filter.push_rtt_sample(60.0, 4.0);
        }
        assert!(filter.state.smoothed_rtt_ms > 58.0);
        assert!(filter.state.rtt_jitter_ms >= 0.0);
        let target_delta = filter.evaluate_pacing(120, 100, 3, 64, 1000.0 / 120.0);
        assert!(target_delta >= 4);
        assert!(filter.state.pacing_rate_hz >= 108.0 && filter.state.pacing_rate_hz <= 132.0);
    }

    #[test]
    fn ignores_non_finite_samples() {
        let mut filter = ClockSyncFilter::new();
        filter.push_rtt_sample(32.0, 1.0);
        filter.push_rtt_sample(f32::NAN, 0.0);
        filter.push_rtt_sample(-10.0, 0.0);
        assert_eq!(filter.state.sample_count, 1);
        assert!((filter.state.smoothed_rtt_ms - 32.0).abs() < 1e-4);
    }
}
