use glam::{Mat3, Mat3A, Quat, Vec3, Vec3A};

#[inline]
pub fn ue_to_three_vec3(v: Vec3A) -> [f32; 3] {
    [v.x, v.z, v.y]
}

#[inline]
pub fn ue_rot_to_three_quat(rot: Mat3A) -> [f32; 4] {
    let fwd = Vec3::new(rot.x_axis.x, rot.x_axis.z, rot.x_axis.y);
    let right = Vec3::new(rot.y_axis.x, rot.y_axis.z, rot.y_axis.y);
    let up = Vec3::new(rot.z_axis.x, rot.z_axis.z, rot.z_axis.y);

    if fwd.length_squared() < 1e-6 || up.length_squared() < 1e-6 || right.length_squared() < 1e-6 {
        return [0.0, 0.0, 0.0, 1.0];
    }

    let mat = Mat3::from_cols(fwd, up, right);
    Quat::from_mat3(&mat).normalize().to_array()
}

#[inline]
pub fn cam_dir_up_to_quat(dir: Vec3, up: Vec3) -> [f32; 4] {
    let z_axis = if dir.length_squared() > 1e-8 {
        -dir.normalize()
    } else {
        Vec3::NEG_Z
    };
    let mut x_axis = up.cross(z_axis);
    if x_axis.length_squared() < 1e-8 {
        x_axis = Vec3::Y.cross(z_axis);
        if x_axis.length_squared() < 1e-8 {
            x_axis = Vec3::X;
        }
    }
    x_axis = x_axis.normalize();
    let y_axis = z_axis.cross(x_axis).normalize();
    let mat = Mat3::from_cols(x_axis, y_axis, z_axis);
    Quat::from_mat3(&mat).normalize().to_array()
}
