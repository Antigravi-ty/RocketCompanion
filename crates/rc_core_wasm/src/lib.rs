use core::cell::UnsafeCell;

use rc_core::{CarControls, SimCore};
use rc_core::render_frame::RenderFrame;

struct WasmSimHost {
    core: SimCore,
    mesh_chunks: Vec<Vec<u8>>,
    telemetry_ptr: *const u8,
    telemetry_len: usize,
}

impl WasmSimHost {
    fn new() -> Self {
        Self {
            core: SimCore::new(),
            mesh_chunks: Vec::new(),
            telemetry_ptr: core::ptr::null(),
            telemetry_len: 0,
        }
    }
}

struct GlobalHost(UnsafeCell<Option<WasmSimHost>>);

// SAFETY: WASM execution in the Dedicated Web Worker is single-threaded.
unsafe impl Sync for GlobalHost {}

static HOST: GlobalHost = GlobalHost(UnsafeCell::new(None));

fn with_host<R>(f: impl FnOnce(&mut WasmSimHost) -> R) -> R {
    // SAFETY: Single-threaded Web Worker access; no re-entrant mutable borrows.
    let slot = unsafe { &mut *HOST.0.get() };
    let host = slot.get_or_insert_with(WasmSimHost::new);
    f(host)
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    // SAFETY: Matches allocation from rc_alloc with exact capacity.
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, size);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_reset_mesh_staging() {
    with_host(|h| {
        h.mesh_chunks.clear();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_push_mesh_chunk(ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() || len == 0 {
        return -1;
    }
    // SAFETY: Caller passes valid WASM linear memory slice allocated via rc_alloc.
    let slice = unsafe { core::slice::from_raw_parts(ptr, len) };
    with_host(|h| {
        h.mesh_chunks.push(slice.to_vec());
        h.mesh_chunks.len() as i32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_finalize_arena_meshes() -> i32 {
    with_host(|h| {
        let refs: Vec<&[u8]> = h.mesh_chunks.iter().map(|v| v.as_slice()).collect();
        let ok = SimCore::load_arena_meshes_from_slices(&refs).is_ok();
        h.mesh_chunks.clear();
        if ok { 0 } else { -1 }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_create_sim() -> i32 {
    with_host(|h| {
        h.core.create_soccar_freeplay(Some(42));
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_set_controls(
    throttle: f32,
    steer: f32,
    pitch: f32,
    yaw: f32,
    roll: f32,
    jump: u32,
    boost: u32,
    handbrake: u32,
    ball_cam: u32,
) {
    with_host(|h| {
        h.core.set_controls(
            CarControls {
                throttle,
                steer,
                pitch,
                yaw,
                roll,
                jump: jump != 0,
                boost: boost != 0,
                handbrake: handbrake != 0,
            },
            ball_cam != 0,
        );
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_set_aspect(aspect: f32) {
    with_host(|h| {
        h.core.set_aspect(aspect);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_reset_kickoff() -> u32 {
    with_host(|h| h.core.reset_kickoff())
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_step_sim() -> u32 {
    with_host(|h| h.core.step())
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_get_render_frame_ptr() -> *const u8 {
    with_host(|h| h.core.render_frame_bytes().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_get_render_frame_byte_len() -> usize {
    RenderFrame::BYTE_LEN
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_prepare_telemetry() -> usize {
    with_host(|h| {
        let bytes = h.core.prepare_telemetry_bytes();
        h.telemetry_ptr = bytes.as_ptr();
        h.telemetry_len = bytes.len();
        h.telemetry_len
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_get_telemetry_ptr() -> *const u8 {
    with_host(|h| h.telemetry_ptr)
}
