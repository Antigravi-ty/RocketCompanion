/**
 * RLRCPropertyAttributeDecoder.ts
 * Bit-level UE3 replicated property attribute decoder for Rocket League .replay files.
 */

import type { RLRCBitReader } from './RLRCBitReader.ts';
import { inferRLRCPropertyType } from './RLRCPropertyTypeCatalog.ts';

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
  const type = inferRLRCPropertyType(propName);
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
      const grantCount = br.readU8();
      const boostAmount = br.readU8();
      const unused1 = br.readU8();
      const unused2 = br.readU8();
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
        const version = br.readU8();
        const body = br.readU32();
        const decal = br.readU32();
        const wheels = br.readU32();
        const rocketTrail = br.readU32();
        const antenna = br.readU32();
        const topper = br.readU32();
        const unknown1 = br.readU32();
        const unknown2 = version > 10 ? br.readU32() : 0;
        const engineAudio = version >= 16 ? br.readU32() : 0;
        const trail = version >= 16 ? br.readU32() : 0;
        const goalExplosion = version >= 16 ? br.readU32() : 0;
        const banner = version >= 17 ? br.readU32() : 0;
        const productId = version >= 19 ? br.readU32() : 0;
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
        const unknown = br.readBool();
        const objectInd = br.readU32();
        const pName = objects[objectInd] || '';
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
        const count = br.readU8();
        const slots: RLRCDecodedProductAttribute[][] = [];
        for (let i = 0; i < count; i++) {
          const itemCount = br.readU8();
          const items: RLRCDecodedProductAttribute[] = [];
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
      const number = br.readBits(3);
      const uniqueId = readUniqueId(br);
      const name = uniqueId.systemId !== 0 ? br.readString() : '';
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
      const instigator = br.readBool() ? br.readI32() : null;
      const pickedUp = br.readU8();
      return { type, value: { instigator, pickedUp, picked_up: pickedUp } };
    }
    case 'Pickup': {
      const instigator = br.readBool() ? br.readI32() : null;
      const pickedUp = br.readBool() ? 1 : 0;
      return { type, value: { instigator, pickedUp, picked_up: pickedUp } };
    }
    case 'StatEvent':
      return { type, value: { unknown1: br.readBool(), objectId: br.readI32() } };
    case 'Explosion': {
      const flag = br.readBool();
      const actor = flag ? -1 : br.readI32();
      const location = br.readCompressedVector(vectorMaxBits, 100.0);
      return { type, value: { flag, actor, location } };
    }
    case 'ExtendedExplosion': {
      const flag = br.readBool();
      const actor = flag ? -1 : br.readI32();
      const location = br.readCompressedVector(vectorMaxBits, 100.0);
      return {
        type,
        value: { flag, actor, location, unknown1: br.readBool(), secondaryActor: br.readI32() },
      };
    }
    case 'Demolish': {
      const attacker = readActiveActor(br);
      const victim = readActiveActor(br);
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
      const attackerPri = readActiveActor(br);
      const selfDemo = readActiveActor(br);
      const selfDemolish = br.readBool();
      const goalExplosionOwner = readActiveActor(br);
      const attacker = readActiveActor(br);
      const victim = readActiveActor(br);
      const attackerVelocity = br.readCompressedVector(vectorMaxBits, 100.0);
      const victimVelocity = br.readCompressedVector(vectorMaxBits, 100.0);
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
