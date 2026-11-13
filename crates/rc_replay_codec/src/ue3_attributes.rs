//! Bit-level UE3 replicated property attribute decoder and speculative unknown-property
//! bitwidth prober for Rocket League `.replay` NetStream frames.

use crate::{
    ue3_bitreader::{Ue3BitReader, Ue3Quat, Ue3Vec3},
    ue3_prop_types::{infer_property_type, PropType},
};

#[derive(Debug, Clone, Copy)]
pub struct Ue3VersionTriplet {
    pub major: i32,
    pub minor: i32,
    pub net: i32,
    pub is_lan: bool,
    pub is_rl223: bool,
    pub extended_cam_settings: bool,
}

impl Ue3VersionTriplet {
    #[inline]
    pub fn is_at_least(&self, major: i32, minor: i32, net: i32) -> bool {
        if self.major != major {
            return self.major > major;
        }
        if self.minor != minor {
            return self.minor > minor;
        }
        self.net >= net
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Ue3RigidBody {
    pub sleeping: bool,
    pub position: Ue3Vec3,
    pub rotation: Ue3Quat,
    pub linear_velocity: Ue3Vec3,
    pub angular_velocity: Ue3Vec3,
}

#[derive(Debug, Clone)]
pub enum DecodedAttr {
    Bool(bool),
    Byte(u8),
    Int(i32),
    Float(f32),
    Str(String),
    ActiveActor { active: bool, actor: i32 },
    RigidBody(Ue3RigidBody),
    ReplicatedBoost { grant_count: u8, boost_amount: u8 },
    TeamPaint { team: u8, primary_color: u8, accent_color: u8 },
    CamSettings { fov: f32, height: f32, angle: f32, distance: f32, stiffness: f32 },
    BodyLoadout(u32),
    TeamBodyLoadout { blue_body: u32, orange_body: u32 },
    Pickup { instigator: Option<i32>, picked_up: u8 },
    Demolish { attacker_actor: i32, victim_actor: i32 },
    Skip,
}

#[inline]
fn read_active_actor(br: &mut Ue3BitReader<'_>) -> Result<(bool, i32), &'static str> {
    Ok((br.read_bool()?, br.read_i32()?))
}

fn read_remote_platform_id(
    br: &mut Ue3BitReader<'_>,
    system_id: u8,
    net_version: i32,
) -> Result<bool, &'static str> {
    match system_id {
        0 => {
            let v = br.read_bits(24)?;
            Ok(v != 0)
        }
        1 | 4 | 5 => {
            let _ = br.read_u64()?;
            Ok(true)
        }
        2 => {
            br.skip_bits(16 * 8)?;
            br.skip_bits((if net_version >= 1 { 16 } else { 8 }) * 8)?;
            let _ = br.read_u64()?;
            Ok(true)
        }
        6 => {
            let _ = br.read_u64()?;
            br.skip_bits(24 * 8)?;
            Ok(true)
        }
        7 => {
            let _ = br.read_u64()?;
            if net_version < 10 {
                br.skip_bits(24 * 8)?;
            }
            Ok(true)
        }
        11 => {
            let _ = br.read_string()?;
            Ok(true)
        }
        _ => Err("Unrecognized UE3 UniqueId system_id"),
    }
}

fn read_unique_id(br: &mut Ue3BitReader<'_>, net_version: i32) -> Result<(u8, bool), &'static str> {
    let sys = br.read_u8()?;
    let nonzero = read_remote_platform_id(br, sys, net_version)?;
    let _local = br.read_u8()?;
    Ok((sys, nonzero))
}

fn read_party_leader(br: &mut Ue3BitReader<'_>, net_version: i32) -> Result<(), &'static str> {
    let sys = br.read_u8()?;
    if sys == 0 {
        return Ok(());
    }
    let _ = read_remote_platform_id(br, sys, net_version)?;
    let _ = br.read_u8()?;
    Ok(())
}

fn read_single_team_loadout(br: &mut Ue3BitReader<'_>) -> Result<u32, &'static str> {
    let version = br.read_u8()?;
    let body = br.read_u32()?;
    let _decal = br.read_u32()?;
    let _wheels = br.read_u32()?;
    let _rocket_trail = br.read_u32()?;
    let _antenna = br.read_u32()?;
    let _topper = br.read_u32()?;
    let _u1 = br.read_u32()?;
    if version > 10 {
        let _ = br.read_u32()?;
    }
    if version >= 16 {
        let _ = br.read_u32()?;
        let _ = br.read_u32()?;
        let _ = br.read_u32()?;
    }
    if version >= 17 {
        let _ = br.read_u32()?;
    }
    if version >= 19 {
        let _ = br.read_u32()?;
    }
    if version >= 22 {
        let _ = br.read_u32()?;
        let _ = br.read_u32()?;
        let _ = br.read_u32()?;
    }
    Ok(body)
}

fn read_online_loadout_list(
    br: &mut Ue3BitReader<'_>,
    objects: &[String],
    ver: &Ue3VersionTriplet,
) -> Result<(), &'static str> {
    let is_new_color = ver.is_at_least(868, 23, 8);
    let is_new_paint = ver.is_at_least(868, 18, 0);
    let count = br.read_u8()?;
    for _ in 0..count {
        let item_count = br.read_u8()?;
        for _ in 0..item_count {
            let _unknown = br.read_bool()?;
            let obj_ind = br.read_u32()? as usize;
            let prop_name = objects.get(obj_ind).map(String::as_str).unwrap_or("");
            if prop_name.contains("ProductAttribute_Painted") {
                if is_new_paint {
                    let _ = br.read_bits(31)?;
                } else {
                    let _ = br.read_bits_max(14)?;
                }
            } else if prop_name.contains("ProductAttribute_UserColor") {
                if is_new_color {
                    let _ = br.read_u32()?;
                } else if br.read_bool()? {
                    let _ = br.read_bits(31)?;
                }
            } else if prop_name.contains("ProductAttribute_Title") {
                let _ = br.read_string()?;
            } else if prop_name.contains("ProductAttribute_TeamEdition") {
                if is_new_paint {
                    let _ = br.read_bits(31)?;
                } else {
                    let _ = br.read_bits_max(14)?;
                }
            } else if prop_name.contains("ProductAttribute_SpecialEdition") {
                let _ = br.read_bits(31)?;
            } else if prop_name.contains("ProductAttribute_Certified") {
                let _ = br.read_bits(31)?;
                let _ = br.read_u32()?;
            }
        }
    }
    Ok(())
}

pub fn decode_property_attribute(
    br: &mut Ue3BitReader<'_>,
    prop_name: &str,
    objects: &[String],
    vector_max_bits: u32,
    ver: &Ue3VersionTriplet,
) -> Result<DecodedAttr, &'static str> {
    let prop_type = infer_property_type(prop_name);
    match prop_type {
        PropType::Boolean => Ok(DecodedAttr::Bool(br.read_bool()?)),
        PropType::Byte => Ok(DecodedAttr::Byte(br.read_u8()?)),
        PropType::Int => Ok(DecodedAttr::Int(br.read_i32()?)),
        PropType::Float => Ok(DecodedAttr::Float(br.read_f32()?)),
        PropType::Int64 => {
            let _ = br.read_u64()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::QWordString => {
            if ver.is_rl223 {
                Ok(DecodedAttr::Str(br.read_string()?))
            } else {
                let v = br.read_u64()?;
                Ok(DecodedAttr::Str(v.to_string()))
            }
        }
        PropType::String => Ok(DecodedAttr::Str(br.read_string()?)),
        PropType::ActiveActor => {
            let (active, actor) = read_active_actor(br)?;
            Ok(DecodedAttr::ActiveActor { active, actor })
        }
        PropType::Enum => {
            let v = br.read_bits(11)?;
            Ok(DecodedAttr::Int(v as i32))
        }
        PropType::FlaggedByte => {
            let _f = br.read_bool()?;
            let b = br.read_u8()?;
            Ok(DecodedAttr::Byte(b))
        }
        PropType::GameMode => {
            let bits = if ver.is_at_least(868, 12, 0) { 8 } else { 2 };
            Ok(DecodedAttr::Byte(br.read_bits(bits)? as u8))
        }
        PropType::Location => {
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            Ok(DecodedAttr::Skip)
        }
        PropType::Rotation => {
            let _ = br.read_rotation_short()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::RigidBody => {
            let sleeping = br.read_bool()?;
            let position = br.read_compressed_vector(vector_max_bits, 100.0)?;
            let rotation = if ver.net >= 7 {
                br.read_compressed_quat()?
            } else {
                br.read_fixed_compressed_quat()?
            };
            let linear_velocity = if sleeping {
                Ue3Vec3::default()
            } else {
                br.read_compressed_vector(vector_max_bits, 100.0)?
            };
            let angular_velocity = if sleeping {
                Ue3Vec3::default()
            } else {
                br.read_compressed_vector(vector_max_bits, 10000.0)?
            };
            Ok(DecodedAttr::RigidBody(Ue3RigidBody {
                sleeping,
                position,
                rotation,
                linear_velocity,
                angular_velocity,
            }))
        }
        PropType::UniqueId => {
            let _ = read_unique_id(br, ver.net)?;
            Ok(DecodedAttr::Skip)
        }
        PropType::PartyLeader => {
            read_party_leader(br, ver.net)?;
            Ok(DecodedAttr::Skip)
        }
        PropType::HonorDuelChallenge => {
            let _ = read_unique_id(br, ver.net)?;
            let _ = read_unique_id(br, ver.net)?;
            Ok(DecodedAttr::Skip)
        }
        PropType::Reservation => {
            let _num = br.read_bits(3)?;
            let (sys, nonzero) = read_unique_id(br, ver.net)?;
            if sys != 0 {
                let _ = br.read_string()?;
            } else if nonzero {
                let _ = br.read_null_terminated_string(255)?;
            }
            let _u1 = br.read_bool()?;
            let _u2 = br.read_bool()?;
            if ver.is_at_least(868, 12, 0) {
                let _ = br.read_bits(6)?;
            }
            Ok(DecodedAttr::Skip)
        }
        PropType::HistoryKey => {
            let _ = br.read_bits(14)?;
            Ok(DecodedAttr::Skip)
        }
        PropType::CamSettings => {
            let fov = br.read_f32()?;
            let height = br.read_f32()?;
            let angle = br.read_f32()?;
            let distance = br.read_f32()?;
            let stiffness = br.read_f32()?;
            let _swivel = br.read_f32()?;
            if ver.is_at_least(868, 20, 0) {
                let _ = br.read_f32()?;
            }
            if ver.extended_cam_settings || ver.is_at_least(868, 34, 12) {
                let _ = br.read_f32()?;
                let _ = br.read_f32()?;
                let _ = br.read_f32()?;
                let _ = br.read_bool()?;
                let _ = br.read_bool()?;
            }
            Ok(DecodedAttr::CamSettings {
                fov,
                height,
                angle,
                distance,
                stiffness,
            })
        }
        PropType::TeamPaint => {
            let team = br.read_u8()?;
            let primary_color = br.read_u8()?;
            let accent_color = br.read_u8()?;
            let _pf = br.read_u32()?;
            let _af = br.read_u32()?;
            Ok(DecodedAttr::TeamPaint {
                team,
                primary_color,
                accent_color,
            })
        }
        PropType::ClubColors => {
            let _ = br.read_bool()?;
            let _ = br.read_u8()?;
            let _ = br.read_bool()?;
            let _ = br.read_u8()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::ReplicatedBoost => {
            let grant_count = br.read_u8()?;
            let boost_amount = br.read_u8()?;
            let _ = br.read_u8()?;
            let _ = br.read_u8()?;
            Ok(DecodedAttr::ReplicatedBoost {
                grant_count,
                boost_amount,
            })
        }
        PropType::Loadout => {
            let body = read_single_team_loadout(br)?;
            Ok(DecodedAttr::BodyLoadout(body))
        }
        PropType::TeamLoadout => {
            let blue_body = read_single_team_loadout(br)?;
            let orange_body = read_single_team_loadout(br)?;
            Ok(DecodedAttr::TeamBodyLoadout {
                blue_body,
                orange_body,
            })
        }
        PropType::LoadoutOnline => {
            read_online_loadout_list(br, objects, ver)?;
            Ok(DecodedAttr::Skip)
        }
        PropType::LoadoutsOnline => {
            read_online_loadout_list(br, objects, ver)?;
            read_online_loadout_list(br, objects, ver)?;
            let _ = br.read_bool()?;
            let _ = br.read_bool()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::PickupNew | PropType::Pickup => {
            let instigator = if br.read_bool()? {
                Some(br.read_i32()?)
            } else {
                None
            };
            let picked_up = if prop_type == PropType::PickupNew {
                br.read_u8()?
            } else if br.read_bool()? {
                1
            } else {
                0
            };
            Ok(DecodedAttr::Pickup {
                instigator,
                picked_up,
            })
        }
        PropType::PickupInfo => {
            let _ = read_active_actor(br)?;
            let _ = read_active_actor(br)?;
            let _ = read_active_actor(br)?;
            let _ = br.read_bool()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::StatEvent => {
            let _ = br.read_bool()?;
            let _ = br.read_i32()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::MusicStinger => {
            let _ = br.read_bool()?;
            let _ = br.read_u32()?;
            let _ = br.read_u8()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::AppliedDamage => {
            let _ = br.read_u8()?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            let _ = br.read_i32()?;
            let _ = br.read_i32()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::DamageState => {
            let _ = br.read_u8()?;
            let _ = br.read_bool()?;
            let _ = br.read_i32()?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            let _ = br.read_bool()?;
            let _ = br.read_bool()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::Welded => {
            let _ = read_active_actor(br)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            let _ = br.read_f32()?;
            let _ = br.read_rotation_short()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::Title => {
            let _ = br.read_bool()?;
            let _ = br.read_bool()?;
            for _ in 0..5 {
                let _ = br.read_u32()?;
            }
            let _ = br.read_bool()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::RepStatTitle => {
            let _ = br.read_bool()?;
            let _ = br.read_string()?;
            let _ = br.read_bool()?;
            let _ = br.read_u32()?;
            let _ = br.read_u32()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::Impulse => {
            let _ = br.read_i32()?;
            let _ = br.read_f32()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::LogoData => {
            let _ = br.read_u32()?;
            let _ = br.read_bool()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::PrivateMatchSettings => {
            let _ = br.read_string()?;
            let _ = br.read_u32()?;
            let _ = br.read_u32()?;
            let _ = br.read_string()?;
            let _ = br.read_string()?;
            let _ = br.read_bool()?;
            Ok(DecodedAttr::Skip)
        }
        PropType::Explosion | PropType::ExtendedExplosion => {
            let _ = read_active_actor(br)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            if prop_type == PropType::ExtendedExplosion {
                let _ = br.read_bool()?;
                let _ = br.read_i32()?;
            }
            Ok(DecodedAttr::Skip)
        }
        PropType::Demolish => {
            let (_, attacker_actor) = read_active_actor(br)?;
            let (_, victim_actor) = read_active_actor(br)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            Ok(DecodedAttr::Demolish {
                attacker_actor,
                victim_actor,
            })
        }
        PropType::DemolishFx => {
            let _ = br.read_bool()?;
            let _ = br.read_i32()?;
            let (_, attacker_actor) = read_active_actor(br)?;
            let (_, victim_actor) = read_active_actor(br)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            Ok(DecodedAttr::Demolish {
                attacker_actor,
                victim_actor,
            })
        }
        PropType::DemolishExtended => {
            let _ = read_active_actor(br)?;
            let _ = read_active_actor(br)?;
            let _ = br.read_bool()?;
            let _ = read_active_actor(br)?;
            let (_, attacker_actor) = read_active_actor(br)?;
            let (_, victim_actor) = read_active_actor(br)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            let _ = br.read_compressed_vector(vector_max_bits, 100.0)?;
            Ok(DecodedAttr::Demolish {
                attacker_actor,
                victim_actor,
            })
        }
        PropType::Unknown => Err("Unknown UE3 property type"),
    }
}
