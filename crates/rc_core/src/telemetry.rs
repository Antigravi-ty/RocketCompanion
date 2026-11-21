use crate::render_frame::RenderFrame;

pub const TELEMETRY_CAPACITY: usize = 240;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct TelemetrySample {
    pub tick: u32,
    pub teleport_seq: u32,
    pub flags: u32,
    pub car_boost: f32,
    pub car_pos: [f32; 3],
    pub car_vel: [f32; 3],
    pub ball_pos: [f32; 3],
    pub cam_pos: [f32; 3],
    pub cam_fov: f32,
}

pub struct TelemetryRingBuffer {
    ring: Vec<TelemetrySample>,
    write_idx: usize,
    count: usize,
    ordered_scratch: Vec<TelemetrySample>,
}

impl TelemetryRingBuffer {
    pub fn new() -> Self {
        Self {
            ring: vec![TelemetrySample::default(); TELEMETRY_CAPACITY],
            write_idx: 0,
            count: 0,
            ordered_scratch: Vec::with_capacity(TELEMETRY_CAPACITY),
        }
    }

    pub fn clear(&mut self) {
        self.write_idx = 0;
        self.count = 0;
        self.ordered_scratch.clear();
    }

    pub fn push(&mut self, frame: &RenderFrame) {
        self.ring[self.write_idx] = TelemetrySample {
            tick: frame.tick,
            teleport_seq: frame.teleport_seq,
            flags: frame.flags,
            car_boost: frame.car_boost,
            car_pos: frame.car_pos,
            car_vel: frame.car_vel,
            ball_pos: frame.ball_pos,
            cam_pos: frame.cam_pos,
            cam_fov: frame.cam_fov,
        };
        self.write_idx = (self.write_idx + 1) % TELEMETRY_CAPACITY;
        if self.count < TELEMETRY_CAPACITY {
            self.count += 1;
        }
    }

    pub fn prepare_ordered_bytes(&mut self) -> &[u8] {
        self.ordered_scratch.clear();
        if self.count == 0 {
            return &[];
        }
        let start = if self.count < TELEMETRY_CAPACITY {
            0
        } else {
            self.write_idx
        };
        for i in 0..self.count {
            let idx = (start + i) % TELEMETRY_CAPACITY;
            self.ordered_scratch.push(self.ring[idx]);
        }
        let byte_len = self.ordered_scratch.len() * core::mem::size_of::<TelemetrySample>();
        // SAFETY: TelemetrySample is #[repr(C)] with plain u32/f32 fields and no padding.
        unsafe {
            core::slice::from_raw_parts(self.ordered_scratch.as_ptr().cast::<u8>(), byte_len)
        }
    }
}
