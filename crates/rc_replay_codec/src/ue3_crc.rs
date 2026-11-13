//! Rocket League CRC32 checksum, little-endian UE3 byte reader, and header property tree parser.

use std::collections::HashMap;

pub const RL_CRC_POLY: u32 = 0x04c1_1db7;
pub const RL_CRC_SEED: u32 = 0xefcb_f201;

const fn build_crc_table() -> [u32; 256] {
    let mut tbl = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = (i as u32) << 24;
        let mut b = 0;
        while b < 8 {
            if (c & 0x8000_0000) != 0 {
                c = (c << 1) ^ RL_CRC_POLY;
            } else {
                c <<= 1;
            }
            b += 1;
        }
        tbl[i] = c;
        i += 1;
    }
    tbl
}

static RL_CRC_TABLE: [u32; 256] = build_crc_table();

/// Computes Rocket League's big-endian polynomial CRC32 over `bytes`.
#[inline]
pub fn compute_rl_crc32(bytes: &[u8], seed: u32) -> u32 {
    let mut crc = !seed;
    for &b in bytes {
        let idx = ((crc >> 24) as u8 ^ b) as usize;
        crc = (crc << 8) ^ RL_CRC_TABLE[idx];
    }
    !crc
}

pub struct Ue3ByteReader<'a> {
    bytes: &'a [u8],
    pub pos: usize,
}

impl<'a> Ue3ByteReader<'a> {
    #[inline]
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    #[inline]
    pub fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    #[inline]
    pub fn read_u8(&mut self) -> Result<u8, &'static str> {
        if self.pos >= self.bytes.len() {
            return Err("Ue3ByteReader::read_u8 EOF");
        }
        let v = self.bytes[self.pos];
        self.pos += 1;
        Ok(v)
    }

    #[inline]
    pub fn read_i32(&mut self) -> Result<i32, &'static str> {
        if self.pos + 4 > self.bytes.len() {
            return Err("Ue3ByteReader::read_i32 EOF");
        }
        let v = i32::from_le_bytes([
            self.bytes[self.pos],
            self.bytes[self.pos + 1],
            self.bytes[self.pos + 2],
            self.bytes[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    #[inline]
    pub fn read_u32(&mut self) -> Result<u32, &'static str> {
        if self.pos + 4 > self.bytes.len() {
            return Err("Ue3ByteReader::read_u32 EOF");
        }
        let v = u32::from_le_bytes([
            self.bytes[self.pos],
            self.bytes[self.pos + 1],
            self.bytes[self.pos + 2],
            self.bytes[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    #[inline]
    pub fn read_u64(&mut self) -> Result<u64, &'static str> {
        let lo = self.read_u32()? as u64;
        let hi = self.read_u32()? as u64;
        Ok((hi << 32) | lo)
    }

    #[inline]
    pub fn read_f32(&mut self) -> Result<f32, &'static str> {
        Ok(f32::from_bits(self.read_u32()?))
    }

    #[inline]
    pub fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], &'static str> {
        let n = len.min(self.remaining());
        let slice = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    pub fn read_ue_string(&mut self) -> Result<String, &'static str> {
        let len = self.read_i32()?;
        if len == 0 {
            return Ok(String::new());
        }
        if len < 0 {
            let char_count = (-len) as usize;
            let byte_len = char_count.saturating_mul(2);
            if byte_len > self.remaining() {
                return Err("Ue3ByteReader::read_ue_string UTF-16 EOF");
            }
            let raw = self.read_bytes(byte_len)?;
            let mut u16s = Vec::with_capacity(char_count);
            for chunk in raw.chunks_exact(2) {
                u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            while u16s.last() == Some(&0) {
                u16s.pop();
            }
            return Ok(String::from_utf16_lossy(&u16s));
        }
        let byte_len = len as usize;
        if byte_len > self.remaining() {
            return Err("Ue3ByteReader::read_ue_string UTF-8 EOF");
        }
        let raw = self.read_bytes(byte_len)?;
        let trimmed = raw
            .iter()
            .position(|&b| b == 0)
            .map_or(raw, |idx| &raw[..idx]);
        Ok(String::from_utf8_lossy(trimmed).into_owned())
    }
}

pub fn read_ue3_table<T>(
    r: &mut Ue3ByteReader<'_>,
    mut f: impl FnMut(&mut Ue3ByteReader<'_>) -> Result<T, &'static str>,
) -> Result<Vec<T>, &'static str> {
    let n = r.read_i32()?;
    if n < 0 || n > 1_000_000 {
        return Err("Invalid UE3 table length");
    }
    let count = n as usize;
    let mut out = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        out.push(f(r)?);
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub enum Ue3PropValue {
    Int(i32),
    Float(f32),
    Str(String),
    Bool(bool),
    QWord(u64),
    Byte {
        enum_name: String,
        value: String,
        raw_u8: Option<u8>,
    },
    Struct {
        struct_name: String,
        fields: HashMap<String, Ue3PropValue>,
    },
    Array(Vec<HashMap<String, Ue3PropValue>>),
    Raw(Vec<u8>),
}

impl Ue3PropValue {
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(v) => Some(*v as i64),
            Self::Float(v) => Some(*v as i64),
            Self::QWord(v) => Some(*v as i64),
            Self::Byte {
                raw_u8: Some(v), ..
            } => Some(*v as i64),
            _ => None,
        }
    }

    pub fn as_f32(&self) -> Option<f32> {
        match self {
            Self::Float(v) => Some(*v),
            Self::Int(v) => Some(*v as f32),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }
}

pub fn read_ue3_property_tree(
    r: &mut Ue3ByteReader<'_>,
) -> Result<HashMap<String, Ue3PropValue>, &'static str> {
    let mut props = HashMap::new();
    while r.remaining() > 0 {
        let name = r.read_ue_string()?;
        if name.is_empty() || name == "None" {
            break;
        }
        let kind = r.read_ue_string()?;
        let byte_len = r.read_i32()?;
        let _arr_idx = r.read_i32()?;

        let val = match kind.as_str() {
            "IntProperty" => Ue3PropValue::Int(r.read_i32()?),
            "FloatProperty" => Ue3PropValue::Float(r.read_f32()?),
            "StrProperty" | "NameProperty" => Ue3PropValue::Str(r.read_ue_string()?),
            "BoolProperty" => Ue3PropValue::Bool(r.read_u8()? != 0),
            "QWordProperty" => Ue3PropValue::QWord(r.read_u64()?),
            "ByteProperty" => {
                let enum_name = r.read_ue_string()?;
                if enum_name == "None" {
                    let raw = r.read_u8()?;
                    Ue3PropValue::Byte {
                        enum_name,
                        value: raw.to_string(),
                        raw_u8: Some(raw),
                    }
                } else {
                    let val_str = r.read_ue_string()?;
                    Ue3PropValue::Byte {
                        enum_name,
                        value: val_str,
                        raw_u8: None,
                    }
                }
            }
            "StructProperty" => {
                let struct_name = r.read_ue_string()?;
                let fields = read_ue3_property_tree(r)?;
                Ue3PropValue::Struct {
                    struct_name,
                    fields,
                }
            }
            "ArrayProperty" => {
                let rows = read_ue3_table(r, read_ue3_property_tree)?;
                Ue3PropValue::Array(rows)
            }
            _ => {
                let n = byte_len.max(0) as usize;
                Ue3PropValue::Raw(r.read_bytes(n)?.to_vec())
            }
        };

        props.insert(name, val);
    }
    Ok(props)
}
