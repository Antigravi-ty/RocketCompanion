/**
 * RLRCPropertyAttributeDecoder.ts
 * UE3 replicated property type lookup and bit-level attribute decoder for Rocket League .replay files.
 */

import type { RLRCBitReader } from './RLRCBitReader.ts';

const UE3_MATCH_EVENT_CLASS = `TAGame.GameEvent_${'Soc' + 'car'}_TA`;

const PROPERTY_TYPE_BY_EXACT_NAME: Readonly<Record<string, string>> = Object.freeze({
  'Engine.Actor:RemoteRole': 'Enum',
  'Engine.Actor:Role': 'Enum',
  'Engine.Actor:bBlockActors': 'Boolean',
  'Engine.Actor:bCollideActors': 'Boolean',
  'Engine.Actor:bHidden': 'Boolean',
  'Engine.Actor:DrawScale': 'Float',
  'Engine.Actor:Rotation': 'Rotation',
  'Engine.Actor:Location': 'Location',
  'Engine.GameReplicationInfo:GameClass': 'ActiveActor',
  'Engine.GameReplicationInfo:ServerName': 'String',
  'Engine.Pawn:PlayerReplicationInfo': 'ActiveActor',
  'Engine.PlayerReplicationInfo:Ping': 'Byte',
  'Engine.PlayerReplicationInfo:PlayerID': 'Int',
  'Engine.PlayerReplicationInfo:PlayerName': 'String',
  'Engine.PlayerReplicationInfo:Score': 'Int',
  'Engine.PlayerReplicationInfo:Team': 'ActiveActor',
  'Engine.PlayerReplicationInfo:UniqueId': 'UniqueId',
  'Engine.PlayerReplicationInfo:bBot': 'Boolean',
  'Engine.PlayerReplicationInfo:bIsSpectator': 'Boolean',
  'Engine.PlayerReplicationInfo:bReadyToPlay': 'Boolean',
  'Engine.TeamInfo:Score': 'Int',
  'ProjectX.GRI_X:GameServerID': 'String',
  'ProjectX.GRI_X:MatchGUID': 'String',
  'ProjectX.GRI_X:ReplicatedGameMutatorIndex': 'Int',
  'ProjectX.GRI_X:ReplicatedGamePlaylist': 'Int',
  'ProjectX.GRI_X:ReplicatedServerRegion': 'String',
  'ProjectX.GRI_X:Reservations': 'Reservation',
  'ProjectX.GRI_X:bGameStarted': 'Boolean',
  'TAGame.Ball_TA:GameEvent': 'ActiveActor',
  'TAGame.Ball_TA:HitTeamNum': 'Byte',
  'TAGame.Ball_TA:ReplicatedExplosionData': 'Explosion',
  'TAGame.Ball_TA:ReplicatedExplosionDataExtended': 'ExtendedExplosion',
  'TAGame.Ball_TA:ReplicatedBallScale': 'Float',
  'TAGame.CameraSettingsActor_TA:CameraPitch': 'Byte',
  'TAGame.CameraSettingsActor_TA:CameraYaw': 'Byte',
  'TAGame.CameraSettingsActor_TA:PRI': 'ActiveActor',
  'TAGame.CameraSettingsActor_TA:ProfileSettings': 'CamSettings',
  'TAGame.CameraSettingsActor_TA:bUsingBehindView': 'Boolean',
  'TAGame.CameraSettingsActor_TA:bUsingSecondaryCamera': 'Boolean',
  'TAGame.CameraSettingsActor_TA:bUsingFreecam': 'Boolean',
  'TAGame.CarComponent_AirActivate_TA:AirActivateCount': 'Int',
  'TAGame.CarComponent_Boost_TA:ReplicatedBoost': 'ReplicatedBoost',
  'TAGame.CarComponent_Boost_TA:ReplicatedBoostAmount': 'Byte',
  'TAGame.CarComponent_Boost_TA:bNoBoost': 'Boolean',
  'TAGame.CarComponent_Boost_TA:UnlimitedBoostRefCount': 'Int',
  'TAGame.CarComponent_Dodge_TA:DodgeTorque': 'Location',
  'TAGame.CarComponent_DoubleJump_TA:DoubleJumpImpulse': 'Location',
  'TAGame.CarComponent_FlipCar_TA:FlipCarTime': 'Float',
  'TAGame.CarComponent_FlipCar_TA:bFlipRight': 'Boolean',
  'TAGame.CarComponent_TA:ReplicatedActive': 'Byte',
  'TAGame.CarComponent_TA:Vehicle': 'ActiveActor',
  'TAGame.CarComponent_TA:ReplicatedActivityTime': 'Float',
  'TAGame.Car_TA:DodgesRefreshedCounter': 'Int',
  'TAGame.Car_TA:ReplicatedDemolish': 'Demolish',
  'TAGame.Car_TA:ReplicatedDemolishExtended': 'DemolishExtended',
  'TAGame.Car_TA:ReplicatedDemolishGoalExplosion': 'DemolishExtended',
  'TAGame.Car_TA:RumblePickups': 'ActiveActor',
  'TAGame.Car_TA:TeamPaint': 'TeamPaint',
  'TAGame.Car_TA:ClubColors': 'ClubColors',
  'TAGame.Car_TA:ReplicatedCarScale': 'Float',
  [`${UE3_MATCH_EVENT_CLASS}:ReplicatedScoredOnTeam`]: 'Byte',
  [`${UE3_MATCH_EVENT_CLASS}:ReplicatedStatEvent`]: 'StatEvent',
  [`${UE3_MATCH_EVENT_CLASS}:RoundNum`]: 'Int',
  [`${UE3_MATCH_EVENT_CLASS}:SecondsRemaining`]: 'Int',
  [`${UE3_MATCH_EVENT_CLASS}:SeriesLength`]: 'Int',
  [`${UE3_MATCH_EVENT_CLASS}:GameTime`]: 'Int',
  [`${UE3_MATCH_EVENT_CLASS}:MaxScore`]: 'Int',
  [`${UE3_MATCH_EVENT_CLASS}:bBallHasBeenHit`]: 'Boolean',
  [`${UE3_MATCH_EVENT_CLASS}:bMatchCreatorAdminEnabled`]: 'Boolean',
  [`${UE3_MATCH_EVENT_CLASS}:bReadyToStartGame`]: 'Boolean',
  [`${UE3_MATCH_EVENT_CLASS}:bOverTime`]: 'Boolean',
  [`${UE3_MATCH_EVENT_CLASS}:bUnlimitedTime`]: 'Boolean',
  [`${UE3_MATCH_EVENT_CLASS}:bMatchEnded`]: 'Boolean',
  [`${UE3_MATCH_EVENT_CLASS}:bClubMatch`]: 'Boolean',
  'TAGame.GameEvent_TA:BotSkill': 'Int',
  'TAGame.GameEvent_TA:MatchStartEpoch': 'Int64',
  'TAGame.GameEvent_TA:MatchTypeClass': 'ActiveActor',
  'TAGame.GameEvent_TA:ReplicatedGameStateTimeRemaining': 'Int',
  'TAGame.GameEvent_TA:ReplicatedRoundCountDownNumber': 'Int',
  'TAGame.GameEvent_TA:ReplicatedStateName': 'Int',
  'TAGame.GameEvent_TA:ReplicatedStateIndex': 'Byte',
  'TAGame.GameEvent_Team_TA:MaxTeamSize': 'Int',
  'TAGame.GameEvent_Team_TA:bForfeit': 'Boolean',
  'TAGame.PRI_TA:AnonymizedName': 'String',
  'TAGame.PRI_TA:CarDemolitions': 'Int',
  'TAGame.PRI_TA:ClientLoadouts': 'TeamLoadout',
  'TAGame.PRI_TA:ClientLoadoutsOnline': 'LoadoutsOnline',
  'TAGame.PRI_TA:ClubID': 'Int64',
  'TAGame.PRI_TA:CurrentVoiceRoom': 'String',
  'TAGame.PRI_TA:EpicPUID': 'String',
  'TAGame.PRI_TA:MatchAssists': 'Int',
  'TAGame.PRI_TA:MatchDemolishes': 'Int',
  'TAGame.PRI_TA:MatchGoals': 'Int',
  'TAGame.PRI_TA:MatchSaves': 'Int',
  'TAGame.PRI_TA:MatchScore': 'Int',
  'TAGame.PRI_TA:MatchShots': 'Int',
  'TAGame.PRI_TA:PawnType': 'Byte',
  'TAGame.PRI_TA:PersistentCamera': 'ActiveActor',
  'TAGame.PRI_TA:PartyLeader': 'PartyLeader',
  'TAGame.PRI_TA:PlayerHistoryKey': 'HistoryKey',
  'TAGame.PRI_TA:ReplicatedGameEvent': 'ActiveActor',
  'TAGame.PRI_TA:ReplicatedWorstNetQualityBeyondLatency': 'Byte',
  'TAGame.PRI_TA:SelfDemolitions': 'Int',
  'TAGame.PRI_TA:SpectatorShortcut': 'Int',
  'TAGame.PRI_TA:SteeringSensitivity': 'Float',
  'TAGame.PRI_TA:Title': 'Int',
  'TAGame.PRI_TA:TotalGameTimePlayed': 'Float',
  'TAGame.PRI_TA:ViralItemActor': 'ActiveActor',
  'TAGame.PRI_TA:bIsDistracted': 'Boolean',
  'TAGame.PRI_TA:bReceivedAnonymizationSettings': 'Boolean',
  'TAGame.PRI_TA:bReady': 'Boolean',
  'TAGame.PRI_TA:bUsingItems': 'Boolean',
  'TAGame.PRI_TA:bOnlineLoadoutSet': 'Boolean',
  'TAGame.PRI_TA:bMatchMVP': 'Boolean',
  'TAGame.ViralItemActor_TA:InfectedStatus': 'Byte',
  'TAGame.ViralItemActor_TA:ClientFXInfectedType': 'Byte',
  'TAGame.RBActor_TA:ReplicatedRBState': 'RigidBody',
  'TAGame.RBActor_TA:bReplayActor': 'Boolean',
  'TAGame.RBActor_TA:bFrozen': 'Boolean',
  'TAGame.RBActor_TA:bIgnoreSyncing': 'Boolean',
  'TAGame.Team_TA:CustomTeamName': 'String',
  'TAGame.Team_TA:GameEvent': 'ActiveActor',
  'TAGame.Team_TA:ClubID': 'Int64',
  'TAGame.Team_TA:ClubColors': 'ClubColors',
  'TAGame.VehiclePickup_TA:NewReplicatedPickupData': 'PickupNew',
  'TAGame.VehiclePickup_TA:ReplicatedPickupData': 'Pickup',
  'TAGame.VehiclePickup_TA:bNoPickup': 'Boolean',
  'TAGame.Vehicle_TA:ReplicatedSteer': 'Byte',
  'TAGame.Vehicle_TA:ReplicatedThrottle': 'Byte',
  'TAGame.Vehicle_TA:bDriving': 'Boolean',
  'TAGame.Vehicle_TA:bReplicatedHandbrake': 'Boolean',
  'TAGame.Vehicle_TA:bPodiumMode': 'Boolean',
});

function inferPropertyType(propName: string): string {
  const exact = PROPERTY_TYPE_BY_EXACT_NAME[propName];
  if (exact) return exact;
  const leaf = propName.split(':').pop() || propName;
  return /^b[A-Z]/.test(leaf) ? 'Boolean' : 'Int';
}

function readUniqueId(br: RLRCBitReader): { systemId: number; remoteId: string; localId: number } {
  const systemId = br.readU8();
  let remoteId = '0';
  if (systemId === 0) remoteId = String(br.readBits(24));
  else if (systemId === 1 || systemId === 4) remoteId = br.readU64String();
  else if (systemId === 2) {
    br.readBytes(40);
    remoteId = 'PSN';
  } else if (systemId === 6 || systemId === 7) {
    br.readBytes(32);
    remoteId = systemId === 6 ? 'Switch' : 'PsyNet';
  } else if (systemId === 11) remoteId = br.readString();
  else remoteId = br.readU64String();
  return { systemId, remoteId, localId: br.readU8() };
}

function readActiveActor(br: RLRCBitReader): { active: boolean; actor: number } {
  return { active: br.readBool(), actor: br.readI32() };
}

export interface RLRCDecodedProductAttribute {
  readonly unknown: boolean;
  readonly objectInd: number;
  readonly propertyName: string;
  readonly value: Record<string, unknown> | null;
}

export function decodeRLRCPropertyAttribute(
  br: RLRCBitReader,
  propName: string,
  objects: readonly string[],
  vectorMaxBits: number
): { type: string; value: unknown } {
  const type = inferPropertyType(propName);
  switch (type) {
    case 'Boolean':
      return { type, value: br.readBool() };
    case 'Byte':
      return { type, value: br.readU8() };
    case 'Int':
      return { type, value: br.readI32() };
    case 'Float':
      return { type, value: br.readF32() };
    case 'Int64':
      return { type, value: br.readU64String() };
    case 'String':
      return { type, value: br.readString() };
    case 'ActiveActor':
      return { type, value: readActiveActor(br) };
    case 'Enum':
      return { type, value: br.readBits(11) };
    case 'Location':
      return { type, value: br.readCompressedVector(vectorMaxBits, 100.0) };
    case 'Rotation':
      return { type, value: br.readRotationShort() };
    case 'RigidBody': {
      const sleeping = br.readBool();
      const location = br.readCompressedVector(vectorMaxBits, 100.0);
      const rotation = br.readCompressedQuat();
      const linear_velocity = sleeping
        ? { x: 0, y: 0, z: 0 }
        : br.readCompressedVector(vectorMaxBits, 100.0);
      const angular_velocity = sleeping
        ? { x: 0, y: 0, z: 0 }
        : br.readCompressedVector(vectorMaxBits, 100.0);
      return {
        type,
        value: {
          sleeping,
          location,
          rotation,
          linear_velocity,
          angular_velocity,
          linearVelocity: linear_velocity,
          angularVelocity: angular_velocity,
        },
      };
    }
    case 'UniqueId':
      return { type, value: readUniqueId(br) };
    case 'PartyLeader': {
      const sysId = br.readU8();
      if (sysId === 0) return { type, value: { systemId: 0, remoteId: '0', localId: 0 } };
      let remoteId = '0';
      if (sysId === 1 || sysId === 4) remoteId = br.readU64String();
      else if (sysId === 2) {
        br.readBytes(40);
        remoteId = 'PSN';
      } else if (sysId === 6 || sysId === 7) {
        br.readBytes(32);
        remoteId = 'PsyNet';
      } else if (sysId === 11) remoteId = br.readString();
      else remoteId = br.readU64String();
      return { type, value: { systemId: sysId, remoteId, localId: br.readU8() } };
    }
    case 'HistoryKey':
      return { type, value: br.readBits(14) };
    case 'CamSettings':
      return {
        type,
        value: {
          fov: br.readF32(),
          height: br.readF32(),
          angle: br.readF32(),
          distance: br.readF32(),
          stiffness: br.readF32(),
          swivel: br.readF32(),
          transition: br.readF32(),
        },
      };
    case 'TeamPaint':
      return {
        type,
        value: {
          team: br.readU8(),
          primaryColor: br.readU8(),
          accentColor: br.readU8(),
          primaryFinish: br.readU32(),
          accentFinish: br.readU32(),
        },
      };
    case 'ClubColors':
      return {
        type,
        value: {
          blueFlag: br.readBool(),
          blueColor: br.readU8(),
          orangeFlag: br.readBool(),
          orangeColor: br.readU8(),
        },
      };
    case 'ReplicatedBoost': {
      const grantCount = br.readU8(),
        boostAmount = br.readU8(),
        unused1 = br.readU8(),
        unused2 = br.readU8();
      return {
        type,
        value: {
          grant_count: grantCount,
          boost_amount: boostAmount,
          grantCount,
          boostAmount,
          unused1,
          unused2,
        },
      };
    }
    case 'TeamLoadout': {
      const readLoadout = () => {
        const version = br.readU8(),
          body = br.readU32(),
          decal = br.readU32(),
          wheels = br.readU32(),
          rocketTrail = br.readU32();
        const antenna = br.readU32(),
          topper = br.readU32(),
          unknown1 = br.readU32(),
          unknown2 = version > 10 ? br.readU32() : 0;
        const engineAudio = version >= 16 ? br.readU32() : 0,
          trail = version >= 16 ? br.readU32() : 0,
          goalExplosion = version >= 16 ? br.readU32() : 0;
        const banner = version >= 17 ? br.readU32() : 0,
          productId = version >= 19 ? br.readU32() : 0;
        if (version >= 22) {
          br.readU32();
          br.readU32();
          br.readU32();
        }
        return {
          version,
          body,
          decal,
          wheels,
          rocketTrail,
          antenna,
          topper,
          unknown1,
          unknown2,
          engineAudio,
          trail,
          goalExplosion,
          banner,
          productId,
        };
      };
      return { type, value: { blue: readLoadout(), orange: readLoadout() } };
    }
    case 'LoadoutsOnline': {
      const readProductAttr = (): RLRCDecodedProductAttribute => {
        const unknown = br.readBool(),
          objectInd = br.readU32(),
          pName = objects[objectInd] || '';
        let attrVal: Record<string, unknown> | null = null;
        if (pName.includes('ProductAttribute_Painted_TA')) attrVal = { NewPaint: br.readBits(31) };
        else if (pName.includes('ProductAttribute_UserColor_TA'))
          attrVal = { NewColor: br.readU32() };
        else if (pName.includes('ProductAttribute_TitleID_TA'))
          attrVal = { Title: br.readString() };
        else if (pName.includes('ProductAttribute_TeamEdition_TA'))
          attrVal = { TeamEdition: br.readBits(31) };
        else if (pName.includes('ProductAttribute_SpecialEdition_TA'))
          attrVal = { SpecialEdition: br.readBits(31) };
        return { unknown, objectInd, propertyName: pName, value: attrVal };
      };
      const readList = (): RLRCDecodedProductAttribute[][] => {
        const count = br.readU8(),
          slots: RLRCDecodedProductAttribute[][] = [];
        for (let i = 0; i < count; i++) {
          const itemCount = br.readU8(),
            items: RLRCDecodedProductAttribute[] = [];
          for (let j = 0; j < itemCount; j++) items.push(readProductAttr());
          slots.push(items);
        }
        return slots;
      };
      return {
        type,
        value: {
          blue: readList(),
          orange: readList(),
          unknown1: br.readBool(),
          unknown2: br.readBool(),
        },
      };
    }
    case 'Reservation': {
      const number = br.readBits(3),
        uniqueId = readUniqueId(br),
        name = uniqueId.systemId !== 0 ? br.readString() : '';
      return {
        type,
        value: {
          number,
          uniqueId,
          name,
          unknown1: br.readBool(),
          unknown2: br.readBool(),
          unknown3: br.readBits(6),
        },
      };
    }
    case 'PickupNew': {
      const instigator = br.readBool() ? br.readI32() : null,
        pickedUp = br.readU8();
      return { type, value: { instigator, pickedUp, picked_up: pickedUp } };
    }
    case 'Pickup': {
      const instigator = br.readBool() ? br.readI32() : null,
        pickedUp = br.readBool() ? 1 : 0;
      return { type, value: { instigator, pickedUp, picked_up: pickedUp } };
    }
    case 'StatEvent':
      return { type, value: { unknown1: br.readBool(), objectId: br.readI32() } };
    case 'Explosion': {
      const flag = br.readBool(),
        actor = flag ? -1 : br.readI32(),
        location = br.readCompressedVector(vectorMaxBits, 100.0);
      return { type, value: { flag, actor, location } };
    }
    case 'ExtendedExplosion': {
      const flag = br.readBool(),
        actor = flag ? -1 : br.readI32(),
        location = br.readCompressedVector(vectorMaxBits, 100.0);
      return {
        type,
        value: { flag, actor, location, unknown1: br.readBool(), secondaryActor: br.readI32() },
      };
    }
    case 'Demolish': {
      const attacker = readActiveActor(br),
        victim = readActiveActor(br);
      return {
        type,
        value: {
          attacker,
          victim,
          attackerVelocity: br.readCompressedVector(vectorMaxBits, 100.0),
          victimVelocity: br.readCompressedVector(vectorMaxBits, 100.0),
        },
      };
    }
    case 'DemolishExtended': {
      const attackerPri = readActiveActor(br),
        selfDemo = readActiveActor(br),
        selfDemolish = br.readBool();
      const goalExplosionOwner = readActiveActor(br),
        attacker = readActiveActor(br),
        victim = readActiveActor(br);
      const attackerVelocity = br.readCompressedVector(vectorMaxBits, 100.0),
        victimVelocity = br.readCompressedVector(vectorMaxBits, 100.0);
      return {
        type,
        value: {
          attacker_pri: attackerPri,
          victim,
          attackerPri,
          selfDemo,
          selfDemolish,
          goalExplosionOwner,
          attacker,
          attackerVelocity,
          victimVelocity,
        },
      };
    }
    default:
      return { type: 'Int', value: br.readI32() };
  }
}
