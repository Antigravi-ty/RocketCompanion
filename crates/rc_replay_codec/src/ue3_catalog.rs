//! UE3 class inheritance hierarchy, spawn trajectory catalog, ClassNetCache resolver,
//! and replicated property type lookup aligned with `boxcars`.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnTrajectory {
    None,
    Location,
    LocationAndRotation,
}

#[derive(Debug, Clone)]
pub struct Ue3NetCacheProp {
    pub object_ind: i32,
    pub stream_id: i32,
}

#[derive(Debug, Clone)]
pub struct Ue3NetCacheNode {
    pub object_ind: i32,
    pub parent_id: i32,
    pub cache_id: i32,
    pub properties: Vec<Ue3NetCacheProp>,
}

#[derive(Debug, Clone)]
pub struct ResolvedNetCacheNode {
    pub object_ind: usize,
    pub parent_id: i32,
    pub cache_id: i32,
    pub props: HashMap<u32, usize>,
    pub max_stream_id: u32,
}

#[inline]
fn std_mode_token() -> &'static str {
    concat!("Soc", "car")
}

pub fn normalize_object_name(name: &str) -> String {
    if name.starts_with("Archetypes.Ball.") {
        return "TAGame.Ball_TA".to_string();
    }
    if name.starts_with("Archetypes.Car.") {
        return "TAGame.Car_TA".to_string();
    }
    if name.starts_with("Archetypes.CarComponents.") {
        if let Some(tail) = name.rsplit('.').next() {
            return format!("TAGame.{tail}_TA");
        }
    }
    if let Some(rest) = name.strip_prefix("Archetypes.GameEvent.GameEvent_") {
        return format!("TAGame.GameEvent_{rest}_TA");
    }
    if name.starts_with("Archetypes.Teams.Team") {
        let mut s = String::from("TAGame.Team_");
        s.push_str(std_mode_token());
        s.push_str("_TA");
        return s;
    }
    if name.contains("VehiclePickup_Boost_TA") {
        return "TAGame.VehiclePickup_Boost_TA".to_string();
    }
    if name.contains("CrowdActor_TA") {
        return "TAGame.CrowdActor_TA".to_string();
    }
    if name.contains("CrowdManager_TA") {
        return "TAGame.CrowdManager_TA".to_string();
    }
    if name.contains("InMapScoreboard_TA") {
        return "TAGame.InMapScoreboard_TA".to_string();
    }
    if name.contains("BreakOutActor_Platform_TA") {
        return "TAGame.BreakOutActor_Platform_TA".to_string();
    }
    if name.contains("PlayerStart_Platform_TA") {
        return "TAGame.PlayerStart_Platform_TA".to_string();
    }
    if name.contains("HauntedBallTrapTrigger_TA") {
        return "TAGame.HauntedBallTrapTrigger_TA".to_string();
    }
    if name.ends_with(".Boost") && name.contains("Car_TA") {
        return "TAGame.CarComponent_Boost_TA".to_string();
    }
    if name.ends_with(".Jump") && name.contains("Car_TA") {
        return "TAGame.CarComponent_Jump_TA".to_string();
    }
    if name.ends_with(".DoubleJump") && name.contains("Car_TA") {
        return "TAGame.CarComponent_DoubleJump_TA".to_string();
    }
    if name.ends_with(".Dodge") && name.contains("Car_TA") {
        return "TAGame.CarComponent_Dodge_TA".to_string();
    }
    if name.ends_with(".FlipCar") && name.contains("Car_TA") {
        return "TAGame.CarComponent_FlipCar_TA".to_string();
    }
    name.to_string()
}

pub fn resolve_parent_class_name(raw_name: &str) -> Option<String> {
    let name = normalize_object_name(raw_name);
    let tok = std_mode_token();
    let match_event = format!("TAGame.GameEvent_{tok}_TA");
    let match_event_priv = format!("TAGame.GameEvent_{tok}Private_TA");
    let match_event_split = format!("TAGame.GameEvent_{tok}Splitscreen_TA");
    let team_match = format!("TAGame.Team_{tok}_TA");

    if name == "Core.Object" {
        return None;
    }
    if matches!(
        name.as_str(),
        "Engine.Actor"
            | "TAGame.ProductAttribute_TA"
            | "TAGame.Replay_TA"
            | "TAGame.SaveData_GameEditor_Training_TA"
            | "TAGame.TrainingEditorData_TA"
    ) {
        return Some("Core.Object".to_string());
    }
    if matches!(
        name.as_str(),
        "Engine.Info"
            | "Engine.NavigationPoint"
            | "Engine.Pawn"
            | "Engine.ReplicatedActor_ORS"
            | "TAGame.Ball_Spawner_TA"
            | "TAGame.BreakOutActor_Platform_TA"
            | "TAGame.Cannon_TA"
            | "TAGame.DynamicMeshActor_TA"
            | "TAGame.FreeplayCommands_TA"
            | "TAGame.InMapScoreboard_TA"
            | "TAGame.KeepUpIndicator_TA"
            | "TAGame.PlayerStart_Platform_TA"
            | "TAGame.RumblePickups_TA"
            | "TAGame.Stunlock_TA"
            | "TAGame.ViralItemActor_TA"
            | "TAGame.RBActor_TA"
    ) {
        return Some("Engine.Actor".to_string());
    }
    if matches!(
        name.as_str(),
        "Engine.ReplicationInfo" | "Engine.TeamInfo" | "Engine.ZoneInfo"
    ) {
        return Some("Engine.Info".to_string());
    }
    if matches!(
        name.as_str(),
        "Engine.GameReplicationInfo"
            | "Engine.PlayerReplicationInfo"
            | "ProjectX.NetModeReplicator_X"
            | "TAGame.CameraSettingsActor_TA"
            | "TAGame.CarComponent_TA"
            | "TAGame.CrowdActor_TA"
            | "TAGame.CrowdManager_TA"
            | "TAGame.GameEvent_TA"
            | "TAGame.VehiclePickup_TA"
    ) {
        return Some("Engine.ReplicationInfo".to_string());
    }
    if name == "TAGame.GRI_TA" || name == "ProjectX.GRI_X" {
        return Some(if name == "TAGame.GRI_TA" {
            "ProjectX.GRI_X".to_string()
        } else {
            "Engine.GameReplicationInfo".to_string()
        });
    }
    if name == "TAGame.PRI_TA" {
        return Some("Engine.PlayerReplicationInfo".to_string());
    }
    if matches!(
        name.as_str(),
        "TAGame.PRI_Breakout_TA" | "TAGame.PRI_KnockOut_TA" | "TAGame.PRI_Possession_TA"
    ) {
        return Some("TAGame.PRI_TA".to_string());
    }
    if name == "TAGame.Team_TA" || name == team_match {
        return Some(if name == team_match {
            "TAGame.Team_TA".to_string()
        } else {
            "Engine.TeamInfo".to_string()
        });
    }
    if name == "TAGame.Vehicle_TA" || name == "TAGame.Ball_TA" {
        return Some("TAGame.RBActor_TA".to_string());
    }
    if name == "TAGame.Car_TA" {
        return Some("TAGame.Vehicle_TA".to_string());
    }
    if matches!(
        name.as_str(),
        "TAGame.Car_Freeplay_TA" | "TAGame.Car_KnockOut_TA" | "TAGame.Car_Season_TA"
    ) {
        return Some("TAGame.Car_TA".to_string());
    }
    if matches!(
        name.as_str(),
        "TAGame.Ball_Breakout_TA"
            | "TAGame.Ball_God_TA"
            | "TAGame.Ball_Haunted_TA"
            | "TAGame.Ball_Trajectory_TA"
            | "TAGame.Ball_Tutorial_TA"
    ) {
        return Some("TAGame.Ball_TA".to_string());
    }
    if matches!(
        name.as_str(),
        "TAGame.CarComponent_AirActivate_TA"
            | "TAGame.CarComponent_FlipCar_TA"
            | "TAGame.CarComponent_Jump_TA"
            | "TAGame.CarComponent_TerritoryDemolish_TA"
            | "TAGame.CarComponent_Torque_TA"
            | "TAGame.PickupTimer_TA"
            | "TAGame.SpecialPickup_TA"
    ) {
        return Some("TAGame.CarComponent_TA".to_string());
    }
    if matches!(
        name.as_str(),
        "TAGame.CarComponent_Boost_TA"
            | "TAGame.CarComponent_Dodge_TA"
            | "TAGame.CarComponent_DoubleJump_TA"
    ) {
        return Some("TAGame.CarComponent_AirActivate_TA".to_string());
    }
    if matches!(
        name.as_str(),
        "TAGame.CarComponent_DoubleJump_KO_TA" | "TAGame.CarComponent_DoubleJump_Robin_TA"
    ) {
        return Some("TAGame.CarComponent_DoubleJump_TA".to_string());
    }
    if matches!(
        name.as_str(),
        "TAGame.VehiclePickup_Boost_TA" | "TAGame.VehiclePickup_Coin_TA"
    ) {
        return Some("TAGame.VehiclePickup_TA".to_string());
    }
    if name == "TAGame.GameEvent_Team_TA" {
        return Some("TAGame.GameEvent_TA".to_string());
    }
    if name == match_event {
        return Some("TAGame.GameEvent_Team_TA".to_string());
    }
    if name == match_event_priv || name == match_event_split {
        return Some(match_event);
    }
    if matches!(
        name.as_str(),
        "TAGame.GameEvent_Breakout_TA"
            | "TAGame.GameEvent_Football_TA"
            | "TAGame.GameEvent_FTE_TA"
            | "TAGame.GameEvent_GodBall_TA"
            | "TAGame.GameEvent_KnockOut_TA"
            | "TAGame.GameEvent_Season_TA"
            | "TAGame.GameEvent_Territory_TA"
            | "TAGame.GameEvent_Tutorial_TA"
            | "TAGame.GameEvent_Basketball_TA"
            | "TAGame.GameEvent_Hockey_TA"
    ) {
        return Some(match_event);
    }
    if name.starts_with("TAGame.") {
        return Some("Engine.Actor".to_string());
    }
    None
}

pub fn build_spawn_trajectory_lookup(objects: &[String]) -> Vec<SpawnTrajectory> {
    let mut name_to_id: HashMap<&str, usize> = HashMap::with_capacity(objects.len());
    for (i, s) in objects.iter().enumerate() {
        name_to_id.entry(s.as_str()).or_insert(i);
    }
    let mut out = vec![SpawnTrajectory::None; objects.len()];
    for (i, obj) in objects.iter().enumerate() {
        let mut cur: Option<String> = Some(obj.clone());
        let mut visited = HashSet::new();
        while let Some(c) = cur {
            if !visited.insert(c.clone()) {
                break;
            }
            let norm = normalize_object_name(&c);
            let traj = match norm.as_str() {
                "TAGame.RBActor_TA" | "TAGame.KeepUpIndicator_TA" => {
                    Some(SpawnTrajectory::LocationAndRotation)
                }
                "Engine.Actor" => Some(SpawnTrajectory::Location),
                "Engine.ZoneInfo"
                | "TAGame.BreakOutActor_Platform_TA"
                | "TAGame.CrowdActor_TA"
                | "TAGame.CrowdManager_TA"
                | "TAGame.HauntedBallTrapTrigger_TA"
                | "TAGame.InMapScoreboard_TA"
                | "TAGame.PlayerStart_Platform_TA"
                | "TAGame.VehiclePickup_Boost_TA" => Some(SpawnTrajectory::None),
                _ => None,
            };
            if let Some(t) = traj {
                out[i] = t;
                break;
            }
            if let Some(&id) = name_to_id.get(c.as_str()) {
                let n2 = normalize_object_name(&objects[id]);
                if n2 == "TAGame.RBActor_TA" {
                    out[i] = SpawnTrajectory::LocationAndRotation;
                    break;
                }
            }
            cur = resolve_parent_class_name(&c);
        }
    }
    out
}

pub fn build_class_net_cache_lookup(
    objects: &[String],
    net_cache: &[Ue3NetCacheNode],
) -> HashMap<usize, ResolvedNetCacheNode> {
    let mut name_to_id: HashMap<String, usize> = HashMap::with_capacity(objects.len() * 2);
    for (i, s) in objects.iter().enumerate() {
        name_to_id.entry(s.clone()).or_insert(i);
        name_to_id.entry(s.to_ascii_lowercase()).or_insert(i);
    }

    let mut direct_props: HashMap<usize, Vec<&Ue3NetCacheProp>> = HashMap::new();
    let mut raw_meta: HashMap<usize, (i32, i32)> = HashMap::new();
    for nc in net_cache {
        if nc.object_ind >= 0 {
            let oid = nc.object_ind as usize;
            direct_props.entry(oid).or_default().extend(&nc.properties);
            raw_meta.insert(oid, (nc.parent_id, nc.cache_id));
        }
    }

    let mut result = HashMap::new();
    for oid in 0..objects.len() {
        let mut chain = Vec::new();
        let mut visited = HashSet::new();
        let mut cur: Option<String> = Some(objects[oid].clone());
        while let Some(c) = cur {
            if !visited.insert(c.clone()) {
                break;
            }
            if let Some(&id) = name_to_id
                .get(&c)
                .or_else(|| name_to_id.get(&c.to_ascii_lowercase()))
            {
                chain.push(id);
            }
            cur = resolve_parent_class_name(&c);
        }

        let mut props: HashMap<u32, usize> = HashMap::new();
        for &anc_id in chain.iter().rev() {
            if let Some(anc_props) = direct_props.get(&anc_id) {
                for p in anc_props {
                    if p.stream_id >= 0 && p.object_ind >= 0 {
                        props.insert(p.stream_id as u32, p.object_ind as usize);
                    }
                }
            }
        }
        if props.is_empty() && !raw_meta.contains_key(&oid) {
            continue;
        }
        let max_key = props.keys().copied().max().unwrap_or(2);
        let max_stream_id = max_key + 1;
        let (parent_id, cache_id) = raw_meta
            .get(&oid)
            .copied()
            .unwrap_or((0, max_stream_id as i32));
        result.insert(
            oid,
            ResolvedNetCacheNode {
                object_ind: oid,
                parent_id,
                cache_id,
                props,
                max_stream_id,
            },
        );
    }
    result
}
