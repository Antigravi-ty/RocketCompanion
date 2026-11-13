//! Self-contained LSB-first bit-packed stream reader for Rocket League UE3 `.replay` NetStream frames.

#[derive(Debug, Clone, Copy, Default)]
pub struct Ue3Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct Ue3Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Default for Ue3Quat {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            z: 0.0,
            w: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Ue3RotationShort {
    pub yaw: Option<i8>,
    pub pitch: Option<i8>,
    pub roll: Option<i8>,
}

pub struct Ue3BitReader<'a> {
    data: &'a [u8],
    bit_pos: usize,
    total_bits: usize,
}

impl<'a> Ue3BitReader<'a> {
    #[inline]
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            bit_pos: 0,
            total_bits: data.len().saturating_mul(8),
        }
    }

    #[inline]
    pub fn bits_remaining(&self) -> usize {
        self.total_bits.saturating_sub(self.bit_pos)
    }

    #[inline]
    pub fn save_bit_pos(&self) -> usize {
        self.bit_pos
    }

    #[inline]
    pub fn restore_bit_pos(&mut self, saved: usize) -> Result<(), &'static str> {
        if saved > self.total_bits {
            return Err("Ue3BitReader::restore_bit_pos out of bounds");
        }
        self.bit_pos = saved;
        Ok(())
    }

    #[inline]
    pub fn skip_bits(&mut self, count: usize) -> Result<(), &'static str> {
        if self.bit_pos.saturating_add(count) > self.total_bits {
            return Err("Ue3BitReader::skip_bits out of bounds");
        }
        self.bit_pos += count;
        Ok(())
    }

    #[inline]
    pub fn read_bit(&mut self) -> Result<u32, &'static str> {
        if self.bit_pos >= self.total_bits {
            return Err("Ue3BitReader::read_bit EOF");
        }
        let byte_idx = self.bit_pos >> 3;
        let bit_idx = self.bit_pos & 7;
        self.bit_pos += 1;
        Ok(((self.data[byte_idx] >> bit_idx) & 1) as u32)
    }

    #[inline]
    pub fn read_bool(&mut self) -> Result<bool, &'static str> {
        Ok(self.read_bit()? == 1)
    }

    #[inline]
    pub fn read_bits(&mut self, count: u32) -> Result<u32, &'static str> {
        if count == 0 {
            return Ok(0);
        }
        if count > 32 || self.bit_pos + (count as usize) > self.total_bits {
            return Err("Ue3BitReader::read_bits out of bounds");
        }
        let mut value = 0u32;
        for i in 0..count {
            let byte_idx = self.bit_pos >> 3;
            let bit_idx = self.bit_pos & 7;
            self.bit_pos += 1;
            value |= (((self.data[byte_idx] >> bit_idx) & 1) as u32) << i;
        }
        Ok(value)
    }

    #[inline]
    pub fn read_bits_max(&mut self, max_val: u32) -> Result<u32, &'static str> {
        if max_val <= 1 {
            return Ok(0);
        }
        let bits = 31u32.saturating_sub(max_val.leading_zeros());
        let mut data = self.read_bits(bits)?;
        let up = data.wrapping_add(1u32 << bits);
        if up < max_val && self.read_bit()? != 0 {
            data = up;
        }
        Ok(data)
    }

    #[inline]
    pub fn read_u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.read_bits(8)? as u8)
    }

    #[inline]
    pub fn read_i8(&mut self) -> Result<i8, &'static str> {
        Ok(self.read_bits(8)? as u8 as i8)
    }

    #[inline]
    pub fn read_u32(&mut self) -> Result<u32, &'static str> {
        let b0 = self.read_bits(8)?;
        let b1 = self.read_bits(8)?;
        let b2 = self.read_bits(8)?;
        let b3 = self.read_bits(8)?;
        Ok(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))
    }

    #[inline]
    pub fn read_i32(&mut self) -> Result<i32, &'static str> {
        Ok(self.read_u32()? as i32)
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

    pub fn read_bytes(&mut self, count: usize) -> Result<Vec<u8>, &'static str> {
        if self.bit_pos.saturating_add(count.saturating_mul(8)) > self.total_bits {
            return Err("Ue3BitReader::read_bytes out of bounds");
        }
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            out.push(self.read_u8()?);
        }
        Ok(out)
    }

    pub fn read_string(&mut self) -> Result<String, &'static str> {
        let length = self.read_i32()?;
        if length == 0 {
            return Ok(String::new());
        }
        if length < 0 {
            let char_count = (-length) as usize;
            if char_count > 4096 {
                return Err("Invalid UTF-16 string length in NetStream");
            }
            let raw = self.read_bytes(char_count * 2)?;
            let mut u16s = Vec::with_capacity(char_count);
            for chunk in raw.chunks_exact(2) {
                u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            while u16s.last() == Some(&0) {
                u16s.pop();
            }
            return Ok(String::from_utf16_lossy(&u16s));
        }
        let byte_len = length as usize;
        if byte_len > 8192 {
            return Err("Invalid UTF-8 string length in NetStream");
        }
        let raw = self.read_bytes(byte_len)?;
        let trimmed = raw
            .iter()
            .position(|&b| b == 0)
            .map_or(raw.as_slice(), |idx| &raw[..idx]);
        Ok(String::from_utf8_lossy(trimmed).into_owned())
    }

    pub fn read_null_terminated_string(&mut self, max_len: usize) -> Result<String, &'static str> {
        let mut bytes = Vec::new();
        while bytes.len() < max_len {
            let b = self.read_u8()?;
            if b == 0 {
                break;
            }
            bytes.push(b);
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn read_compressed_vector(
        &mut self,
        max_bits: u32,
        scale: f32,
    ) -> Result<Ue3Vec3, &'static str> {
        let num_bits = self.read_bits_max(max_bits)?;
        let bias = 1i64 << (num_bits + 1);
        let bit_len = num_bits + 2;
        let dx = (self.read_bits(bit_len)? as i64 - bias) as f32;
        let dy = (self.read_bits(bit_len)? as i64 - bias) as f32;
        let dz = (self.read_bits(bit_len)? as i64 - bias) as f32;
        if (scale - 1.0).abs() < f32::EPSILON {
            Ok(Ue3Vec3 {
                x: dx,
                y: dy,
                z: dz,
            })
        } else {
            let inv = 1.0 / scale;
            Ok(Ue3Vec3 {
                x: dx * inv,
                y: dy * inv,
                z: dz * inv,
            })
        }
    }

    pub fn read_rotation_short(&mut self) -> Result<Ue3RotationShort, &'static str> {
        let yaw = if self.read_bool()? {
            Some(self.read_i8()?)
        } else {
            None
        };
        let pitch = if self.read_bool()? {
            Some(self.read_i8()?)
        } else {
            None
        };
        let roll = if self.read_bool()? {
            Some(self.read_i8()?)
        } else {
            None
        };
        Ok(Ue3RotationShort { yaw, pitch, roll })
    }

    pub fn read_compressed_quat(&mut self) -> Result<Ue3Quat, &'static str> {
        let max_ind = self.read_bits(2)?;
        let inv_scale = 2.0f64 / ((1u32 << 18) - 1) as f64;
        let inv_sqrt2 = std::f64::consts::FRAC_1_SQRT_2;
        let a = ((self.read_bits(18)? as f64) * inv_scale - 1.0) * inv_sqrt2;
        let b = ((self.read_bits(18)? as f64) * inv_scale - 1.0) * inv_sqrt2;
        let c = ((self.read_bits(18)? as f64) * inv_scale - 1.0) * inv_sqrt2;
        let missing = (1.0 - a * a - b * b - c * c).max(0.0).sqrt();
        let (a, b, c, m) = (a as f32, b as f32, c as f32, missing as f32);
        Ok(match max_ind {
            0 => Ue3Quat {
                x: m,
                y: a,
                z: b,
                w: c,
            },
            1 => Ue3Quat {
                x: a,
                y: m,
                z: b,
                w: c,
            },
            2 => Ue3Quat {
                x: a,
                y: b,
                z: m,
                w: c,
            },
            _ => Ue3Quat {
                x: a,
                y: b,
                z: c,
                w: m,
            },
        })
    }

    pub fn read_fixed_compressed_quat(&mut self) -> Result<Ue3Quat, &'static str> {
        let inv = 1.0f32 / 32767.0;
        let x = (self.read_bits(16)? as i32 - 32768) as f32 * inv;
        let y = (self.read_bits(16)? as i32 - 32768) as f32 * inv;
        let z = (self.read_bits(16)? as i32 - 32768) as f32 * inv;
        let w = (1.0 - x * x - y * y - z * z).max(0.0).sqrt();
        Ok(Ue3Quat { x, y, z, w })
    }
}
