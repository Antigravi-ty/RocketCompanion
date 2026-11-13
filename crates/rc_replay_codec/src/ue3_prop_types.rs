//! Replicated UE3 property type enum and deterministic property-name inference.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropType {
    ActiveActor,
    AppliedDamage,
    Boolean,
    Byte,
    CamSettings,
    ClubColors,
    DamageState,
    Demolish,
    DemolishExtended,
    DemolishFx,
    Enum,
    Explosion,
    ExtendedExplosion,
    FlaggedByte,
    Float,
    GameMode,
    HistoryKey,
    HonorDuelChallenge,
    Impulse,
    Int,
    Int64,
    Loadout,
    LoadoutOnline,
    LoadoutsOnline,
    Location,
    LogoData,
    MusicStinger,
    PartyLeader,
    Pickup,
    PickupInfo,
    PickupNew,
    PrivateMatchSettings,
    QWordString,
    ReplicatedBoost,
    RepStatTitle,
    Reservation,
    RigidBody,
    Rotation,
    StatEvent,
    String,
    TeamLoadout,
    TeamPaint,
    Title,
    UniqueId,
    Unknown,
    Welded,
}

pub fn infer_property_type(prop_name: &str) -> PropType {
    let tail = prop_name.rsplit(':').next().unwrap_or(prop_name);
    let low = tail.to_ascii_lowercase();

    match tail {
        "ReplicatedRBState" => return PropType::RigidBody,
        "ReplicatedBoost" => return PropType::ReplicatedBoost,
        "ReplicatedBoostAmount" => return PropType::Byte,
        "NewReplicatedPickupData" => return PropType::PickupNew,
        "ReplicatedPickupData" => return PropType::Pickup,
        "ReplicatedPickupInfo" => return PropType::PickupInfo,
        "ReplicatedDemolish" => return PropType::Demolish,
        "ReplicatedDemolish_CustomFX" => return PropType::DemolishFx,
        "ReplicatedDemolishExtended" => return PropType::DemolishExtended,
        "ReplicatedGoalScored" | "bScored" => return PropType::Boolean,
        "CameraSettings" => return PropType::CamSettings,
        "ClientLoadout" => return PropType::Loadout,
        "ClientLoadoutOnline" => return PropType::LoadoutOnline,
        "ClientLoadoutsOnline" => return PropType::LoadoutsOnline,
        "ClientLoadouts" => return PropType::TeamLoadout,
        "TeamPaint" => return PropType::TeamPaint,
        "ClubColors" => return PropType::ClubColors,
        "UniqueId" => return PropType::UniqueId,
        "PartyLeader" => return PropType::PartyLeader,
        "Reservations" => return PropType::Reservation,
        "ReplicatedGameMode" | "GameMode" => return PropType::GameMode,
        "ReplicatedMusicStinger" => return PropType::MusicStinger,
        "ReplicatedTitle" => return PropType::Title,
        "PrivateMatchSettings" => return PropType::PrivateMatchSettings,
        "WeldedInfo" => return PropType::Welded,
        "ReplicatedDamageState" => return PropType::DamageState,
        "ReplicatedAppliedDamage" => return PropType::AppliedDamage,
        "ReplicatedImpulse" => return PropType::Impulse,
        "ReplicatedExplosionData" => return PropType::Explosion,
        "ReplicatedExplosionDataExtended" => return PropType::ExtendedExplosion,
        "StatEvent" => return PropType::StatEvent,
        "ReplicatedStatTitle" => return PropType::RepStatTitle,
        "ReplicatedLogoData" => return PropType::LogoData,
        "HonorDuelChallenge" => return PropType::HonorDuelChallenge,
        "HistoryKey" => return PropType::HistoryKey,
        "Location" => return PropType::Location,
        "Rotation" => return PropType::Rotation,
        "Team"
        | "PlayerReplicationInfo"
        | "Vehicle"
        | "Car"
        | "Ball"
        | "GameEvent"
        | "Owner"
        | "ReplicatedOwner"
        | "GameClass"
        | "MatchWinner"
        | "GameWinner"
        | "MVP"
        | "AttackerPRI"
        | "ClosestTargetPRI"
        | "TargetPRI"
        | "ReplicatedDamagedActor"
        | "ReplicatedOwnerPRI"
        | "AttachedCar"
        | "BreakOutPlatform" => return PropType::ActiveActor,
        "PlayerName"
        | "ServerName"
        | "MatchGuid"
        | "MatchGUID"
        | "ReplicatedServerRegion"
        | "RemoteUserData"
        | "ClubName"
        | "ClubTag"
        | "TournamentName"
        | "ReplayName" => return PropType::String,
        "GameServerID" | "ClubID" => return PropType::QWordString,
        "SecondsRemaining"
        | "PlayerID"
        | "Score"
        | "MatchGoals"
        | "MatchAssists"
        | "MatchSaves"
        | "MatchShots"
        | "MatchScore"
        | "MatchDemolishes"
        | "ReplicatedGameMutatorIndex"
        | "ReplicatedGamePlaylist"
        | "ReplicatedRoundCountDownNumber"
        | "ReplicatedStateName"
        | "HealthMax"
        | "TotalXP"
        | "BotBannerProductID"
        | "Title"
        | "PawnType"
        | "SpectatorShortcut"
        | "MaxTimeTillItem" => return PropType::Int,
        "DrawScale"
        | "ExtraSpeed"
        | "BoostAmount"
        | "CurrentBoostAmount"
        | "StartBoostAmount"
        | "RespawnTimeRemaining"
        | "BallHitSpinScale"
        | "WorldScale" => return PropType::Float,
        "RemoteRole" | "Role" => return PropType::Enum,
        "Ping"
        | "RemoteViewPitch"
        | "ReplicatedActive"
        | "ReplicatedHandbrake"
        | "ReplicatedBoostActive"
        | "ReplicatedSteer"
        | "ReplicatedThrottle"
        | "TeamNum"
        | "BotSkill"
        | "TimeDilation" => return PropType::Byte,
        _ => {}
    }

    if tail.starts_with('b')
        && tail
            .chars()
            .nth(1)
            .is_some_and(|c| c.is_ascii_uppercase())
    {
        return PropType::Boolean;
    }
    if low.contains("rbstate") {
        return PropType::RigidBody;
    }
    if low.contains("loadout") {
        return PropType::Loadout;
    }
    PropType::Unknown
}
