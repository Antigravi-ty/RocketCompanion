use std::cell::RefCell;

use rc_core::{RcCoreSim, render_frame::RenderFramePod};
use rocketsim::CarControls;

thread_local! {
    static SIM: RefCell<Option<RcCoreSim>> = const { RefCell::new(None) };
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_alloc(byte_len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(byte_len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_free(ptr: *mut u8, byte_len: usize) {
    if !ptr.is_null() && byte_len > 0 {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, 0, byte_len);
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_init_arena(
    mesh_data: *const u8,
    mesh_sizes: *const i32,
    chunk_count: i32,
) -> i32 {
    if mesh_data.is_null() || mesh_sizes.is_null() || chunk_count <= 0 {
        return 0;
    }
    let count = chunk_count as usize;
    let mut slices = Vec::with_capacity(count);
    unsafe {
        let sizes = core::slice::from_raw_parts(mesh_sizes, count);
        let mut offset = 0usize;
        for &sz in sizes {
            if sz <= 0 {
                return 0;
            }
            let len = sz as usize;
            slices.push(core::slice::from_raw_parts(mesh_data.add(offset), len));
            offset += len;
        }
    }
    if rocketsim::init_or_reload_soccar_from_slices(&slices).is_err() {
        return 0;
    }
    SIM.with(|cell| {
        *cell.borrow_mut() = Some(RcCoreSim::new_soccar_freeplay());
    });
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_set_controls(
    throttle: f32,
    steer: f32,
    pitch: f32,
    yaw: f32,
    roll: f32,
    jump: i32,
    boost: i32,
    handbrake: i32,
    ball_cam: i32,
) {
    let controls = CarControls {
        throttle,
        steer,
        pitch,
        yaw,
        roll,
        jump: jump != 0,
        boost: boost != 0,
        handbrake: handbrake != 0,
    };
    SIM.with(|cell| {
        if let Some(sim) = cell.borrow_mut().as_mut() {
            sim.set_controls(controls, ball_cam != 0);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_step(ticks: u32) {
    SIM.with(|cell| {
        if let Some(sim) = cell.borrow_mut().as_mut() {
            sim.step(ticks);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_reset_kickoff(seed: i32) {
    SIM.with(|cell| {
        if let Some(sim) = cell.borrow_mut().as_mut() {
            let opt_seed = if seed < 0 { None } else { Some(seed as u64) };
            sim.reset_kickoff(opt_seed);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_get_frame_len() -> usize {
    RenderFramePod::BYTE_LEN
}

#[unsafe(no_mangle)]
pub extern "C" fn rc_copy_frame(out_ptr: *mut u8) -> usize {
    if out_ptr.is_null() {
        return 0;
    }
    SIM.with(|cell| {
        if let Some(sim) = cell.borrow().as_ref() {
            let bytes = sim.render_frame_bytes();
            unsafe {
                core::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len());
            }
            bytes.len()
        } else {
            0
        }
    })
}
