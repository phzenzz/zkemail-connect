use anchor_lang::prelude::*;

pub const NUM_PUBLIC_INPUTS: usize = 7;
pub const FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Debug, Clone)]
pub struct PublicInputs {
    pub pubkey_hash: [u8; 32],
    pub commitment: [u8; 32],
    pub timestamp: u64,
    pub relayer: [u8; 32],
    pub dest_a: [u8; 32],
    pub dest_b: [u8; 32],
    pub domain_commitment: [u8; 32],
}

pub fn parse_public_inputs(raw: &[[u8; 32]; NUM_PUBLIC_INPUTS]) -> Result<PublicInputs> {
    let mut ts = [0u8; 8];
    // timestamp must fit u64: high 24 bytes must be zero
    require!(
        raw[2][..24].iter().all(|b| *b == 0),
        crate::errors::ErrorCode::TimestampOutOfWindow
    );
    ts.copy_from_slice(&raw[2][24..]);
    Ok(PublicInputs {
        pubkey_hash: raw[0],
        commitment: raw[1],
        timestamp: u64::from_be_bytes(ts),
        relayer: raw[3],
        dest_a: raw[4],
        dest_b: raw[5],
        domain_commitment: raw[6],
    })
}

/// Unpack one 31-byte-LE-packed field element (given as 32-byte BE integer) to its 31 bytes.
/// The most significant byte of the BE integer must be zero (chunk < 2^248).
pub fn field_to_bytes31(field: &[u8; 32]) -> Result<[u8; 31]> {
    require!(
        field[0] == 0,
        crate::errors::ErrorCode::InvalidDestField
    );
    let mut out = [0u8; 31];
    for i in 0..31 {
        out[i] = field[31 - i];
    } // reverse low 31 bytes
    Ok(out)
}

/// Decode dest pubkey from the two packed subject fields.
pub fn decode_dest(dest_a: &[u8; 32], dest_b: &[u8; 32]) -> Result<Pubkey> {
    let a = field_to_bytes31(dest_a)?;
    let b = field_to_bytes31(dest_b)?;
    let mut ascii = [0u8; 44];
    ascii[..31].copy_from_slice(&a);
    ascii[31..].copy_from_slice(&b[..13]);
    // length = last nonzero index + 1; trailing zeros are padding
    let len = ascii
        .iter()
        .rposition(|c| *c != 0)
        .map(|i| i + 1)
        .unwrap_or(0);
    require!(
        len >= 32 && len <= 44,
        crate::errors::ErrorCode::InvalidDestAddress
    );
    let mut out = [0u8; 32];
    five8::decode_32(&ascii[..len], &mut out)
        .map_err(|_| crate::errors::ErrorCode::InvalidDestAddress)?;
    Ok(Pubkey::new_from_array(out))
}

/// Map a 32-byte pubkey to a BN254 field element: BE integer mod Fr (<= 5 subtractions).
pub fn pubkey_to_field(pk: &Pubkey) -> [u8; 32] {
    let mut x = pk.to_bytes();
    while ge_be(&x, &FR_MODULUS) {
        sub_be(&mut x, &FR_MODULUS);
    }
    x
}

fn ge_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

fn sub_be(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let d = a[i] as i32 - b[i] as i32 - borrow as i32;
        if d < 0 {
            a[i] = (d + 256) as u8;
            borrow = 1;
        } else {
            a[i] = d as u8;
            borrow = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack31_le(bytes: &[u8]) -> [u8; 32] {
        // mirror of the circuit/TS packing: chunk integer little-endian, stored BE
        let mut v = [0u8; 32];
        for (j, b) in bytes.iter().enumerate() {
            v[j] = *b;
        }
        let mut be = [0u8; 32];
        for i in 0..31 {
            be[31 - i] = v[i];
        }
        be
    }

    #[test]
    fn roundtrip_dest() {
        let dest = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
        let bytes = dest.as_bytes();
        let fa = pack31_le(&bytes[..31]);
        let fb = pack31_le(&bytes[31..]);
        let pk = decode_dest(&fa, &fb).unwrap();
        assert_eq!(pk.to_string(), dest);
    }

    #[test]
    fn rejects_bad_alphabet() {
        let bytes = b"0uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM"; // '0' invalid
        let fa = pack31_le(&bytes[..31]);
        let fb = pack31_le(&bytes[31..]);
        assert!(decode_dest(&fa, &fb).is_err());
    }

    #[test]
    fn pubkey_field_mod_fr() {
        let pk = Pubkey::new_from_array([0xffu8; 32]);
        let f = pubkey_to_field(&pk);
        assert!(ge_be(&[0xffu8; 32], &FR_MODULUS)); // sanity: reduction happened
        assert!(!ge_be(&f, &FR_MODULUS));
    }
}
