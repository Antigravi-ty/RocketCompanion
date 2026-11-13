//! `ReplayCodecWorkspace`: Persistent WASM linear-memory workspace for `.rlrc` / `.replay`
//! import/export buffers, streaming chunk ingestion, roster descriptors, bookmarks,
//! touch timeline analysis, and anomaly diff reports.

use rc_physics_sim::{layout::MAX_CARS, replay::ReplayStorage};

use crate::{
    container::{
        decode_rcreplay_v2_container, encode_rcreplay_v2_container, is_rcreplay_v2_container,
    },
    touch_analyzer::TouchAnalysisWorkspace,
    types::{
        ReplayAnomalyDiffPod, ReplayBookmarkPod, ReplayRosterSlotPod, ReplayStreamHeaderPod,
        RLRC_TICK_RATE_HZ,
    },
    ue3_header::{parse_ue3_replay_header, populate_stream_header},
    ue3_netstream::decode_ue3_netstream,
    ue3_resample::resample_ue3_timeline_to_storage,
};

pub struct ReplayCodecWorkspace {
    pub header: ReplayStreamHeaderPod,
    pub import_buffer: Vec<u8>,
    pub import_chunk_scratch: Vec<u8>,
    pub import_written_bytes: usize,
    pub export_buffer: Vec<u8>,
    pub roster: [ReplayRosterSlotPod; MAX_CARS],
    pub bookmarks: Vec<ReplayBookmarkPod>,
    pub keyframes: Vec<ReplayBookmarkPod>,
    pub anomaly_diff: ReplayAnomalyDiffPod,
    pub touch_analysis: TouchAnalysisWorkspace,
}

impl Default for ReplayCodecWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

impl ReplayCodecWorkspace {
    pub fn new() -> Self {
        let mut roster = [ReplayRosterSlotPod::default(); MAX_CARS];
        for (i, slot) in roster.iter_mut().enumerate() {
            slot.slot_index = i as u32;
            slot.team = (i % 2) as u32;
        }
        Self {
            header: ReplayStreamHeaderPod {
                magic: 0x524C_5243,
                version: 2,
                container_format: 0,
                status_code: 0,
                frame_count: 0,
                source_frame_count: 0,
                tick_rate_hz: RLRC_TICK_RATE_HZ,
                record_fps: 30.0,
                duration_seconds: 0.0,
                regulation_seconds: 300.0,
                active_car_mask: 0,
                roster_count: 0,
                blue_score: 0,
                orange_score: 0,
                incident_count: 0,
                signal_count: 0,
                bookmark_count: 0,
                keyframe_count: 0,
                part1_crc_valid: 1,
                part2_crc_valid: 1,
            },
            import_buffer: Vec::new(),
            import_chunk_scratch: Vec::new(),
            import_written_bytes: 0,
            export_buffer: Vec::new(),
            roster,
            bookmarks: Vec::new(),
            keyframes: Vec::new(),
            anomaly_diff: ReplayAnomalyDiffPod::default(),
            touch_analysis: TouchAnalysisWorkspace::default(),
        }
    }

    pub fn alloc_import_buffer(&mut self, byte_len: usize) -> *mut u8 {
        if byte_len == 0 {
            self.import_buffer.clear();
            self.import_written_bytes = 0;
            return core::ptr::null_mut();
        }
        self.import_buffer.clear();
        self.import_buffer.resize(byte_len, 0);
        self.import_written_bytes = byte_len;
        self.import_buffer.as_mut_ptr()
    }

    pub fn begin_import_stream(&mut self, total_bytes: usize) -> i32 {
        self.import_buffer.clear();
        self.import_written_bytes = 0;
        if total_bytes > 0 {
            self.import_buffer.reserve(total_bytes.min(32 * 1024 * 1024));
        }
        1
    }

    pub fn alloc_import_chunk_buffer(&mut self, chunk_len: usize) -> *mut u8 {
        if chunk_len == 0 {
            return core::ptr::null_mut();
        }
        if self.import_chunk_scratch.len() < chunk_len {
            self.import_chunk_scratch.resize(chunk_len, 0);
        }
        self.import_chunk_scratch.as_mut_ptr()
    }

    pub fn commit_import_chunk(&mut self, offset: usize, chunk_len: usize) -> i32 {
        if chunk_len == 0 || chunk_len > self.import_chunk_scratch.len() {
            return -1;
        }
        let end = offset.saturating_add(chunk_len);
        if end > self.import_buffer.len() {
            self.import_buffer.resize(end, 0);
        }
        self.import_buffer[offset..end].copy_from_slice(&self.import_chunk_scratch[..chunk_len]);
        self.import_written_bytes = self.import_written_bytes.max(end);
        self.import_written_bytes as i32
    }

    pub fn decode_imported_stream_with_options(
        &mut self,
        byte_len: usize,
        interpolation_mode: i32,
        synthesize_controls: bool,
        replay: &mut ReplayStorage,
    ) -> i32 {
        let len = byte_len.min(self.import_buffer.len());
        if len < 16 {
            self.header.status_code = -1;
            return 0;
        }
        let slice = &self.import_buffer[..len];
        if is_rcreplay_v2_container(slice) {
            let mut roster_vec = Vec::new();
            let mut bm_vec = Vec::new();
            let frames = decode_rcreplay_v2_container(
                slice,
                replay,
                &mut self.header,
                &mut roster_vec,
                &mut bm_vec,
            );
            for (i, r) in roster_vec.into_iter().take(MAX_CARS).enumerate() {
                self.roster[i] = r;
            }
            self.bookmarks = bm_vec;
            return frames;
        }

        let parsed = match parse_ue3_replay_header(slice) {
            Ok(p) => p,
            Err(_) => {
                self.header.status_code = -4;
                return 0;
            }
        };
        populate_stream_header(&parsed, &mut self.header);

        let timeline = match decode_ue3_netstream(&parsed) {
            Ok(t) => t,
            Err(_) => {
                self.header.status_code = -5;
                return 0;
            }
        };

        let hermite = interpolation_mode != 1;
        let frames = resample_ue3_timeline_to_storage(
            &parsed,
            timeline,
            hermite,
            synthesize_controls,
            replay,
            &mut self.header,
            &mut self.roster,
            &mut self.bookmarks,
        );
        self.keyframes.clear();
        for bm in &self.bookmarks {
            if bm.kind_code == 5 {
                self.keyframes.push(*bm);
            }
        }
        self.header.keyframe_count = self.keyframes.len() as u32;
        frames
    }

    pub fn decode_imported_stream(&mut self, byte_len: usize, replay: &mut ReplayStorage) -> i32 {
        self.decode_imported_stream_with_options(byte_len, 0, true, replay)
    }

    pub fn encode_export_stream(
        &mut self,
        replay: &ReplayStorage,
        use_delta_transpose: bool,
    ) -> usize {
        self.header.frame_count = replay.state_track.len() as u32;
        self.header.incident_count = replay.incident_track.len() as u32;
        self.header.signal_count = replay.signal_track.len() as u32;
        self.header.bookmark_count = self.bookmarks.len() as u32;
        self.header.keyframe_count = self.keyframes.len() as u32;
        encode_rcreplay_v2_container(
            replay,
            &self.header,
            &self.bookmarks,
            &self.keyframes,
            use_delta_transpose,
            &mut self.export_buffer,
        )
    }
}
