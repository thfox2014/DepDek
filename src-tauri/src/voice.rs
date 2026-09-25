//! Input validation for the local, offline speech recognizer.
//!
//! Audio is accepted only from the UI's fixed 16 kHz mono PCM WAV encoder.
//! It is decoded in memory and is never written to the vault or a temp file.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

pub const MAX_WAV_BYTES: usize = 44 + 16_000 * 2 * 30;
const MAX_BASE64_BYTES: usize = MAX_WAV_BYTES.div_ceil(3) * 4;

pub fn decode_pcm_wav(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > MAX_BASE64_BYTES {
        return Err("录音最长 30 秒".into());
    }
    let wav = BASE64
        .decode(encoded)
        .map_err(|_| "录音数据格式无效".to_string())?;
    validate_pcm_wav(&wav)?;
    Ok(wav)
}

pub fn validate_pcm_wav(wav: &[u8]) -> Result<(), String> {
    if wav.len() < 46 || wav.len() > MAX_WAV_BYTES {
        return Err("录音长度必须在 30 秒以内".into());
    }
    let u16_at = |n: usize| u16::from_le_bytes([wav[n], wav[n + 1]]);
    let u32_at = |n: usize| u32::from_le_bytes([wav[n], wav[n + 1], wav[n + 2], wav[n + 3]]);
    let pcm = &wav[0..4] == b"RIFF"
        && &wav[8..12] == b"WAVE"
        && &wav[12..16] == b"fmt "
        && u32_at(16) == 16
        && u16_at(20) == 1
        && u16_at(22) == 1
        && u32_at(24) == 16_000
        && u32_at(28) == 32_000
        && u16_at(32) == 2
        && u16_at(34) == 16
        && &wav[36..40] == b"data";
    if !pcm {
        return Err("仅支持 16 kHz 单声道 PCM 录音".into());
    }
    let data_len = u32_at(40) as usize;
    if data_len == 0 || data_len % 2 != 0 || data_len + 44 != wav.len() || u32_at(4) as usize + 8 != wav.len() {
        return Err("录音 WAV 长度不一致".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_wav(sample_bytes: usize) -> Vec<u8> {
        let mut wav = Vec::with_capacity(44 + sample_bytes);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&((36 + sample_bytes) as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&32_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(sample_bytes as u32).to_le_bytes());
        wav.resize(44 + sample_bytes, 0);
        wav
    }

    #[test]
    fn accepts_bounded_pcm_16khz_mono_wav() {
        assert!(validate_pcm_wav(&fixture_wav(320)).is_ok());
        assert!(decode_pcm_wav(&BASE64.encode(fixture_wav(320))).is_ok());
    }

    #[test]
    fn rejects_empty_corrupt_stereo_and_oversized_audio() {
        assert!(validate_pcm_wav(&[]).is_err());
        let mut stereo = fixture_wav(320);
        stereo[22..24].copy_from_slice(&2u16.to_le_bytes());
        assert!(validate_pcm_wav(&stereo).is_err());
        assert!(validate_pcm_wav(&fixture_wav(0)).is_err());
        assert!(validate_pcm_wav(&fixture_wav(MAX_WAV_BYTES)).is_err());
        assert!(decode_pcm_wav(&"A".repeat(MAX_BASE64_BYTES + 4)).is_err());
    }
}
