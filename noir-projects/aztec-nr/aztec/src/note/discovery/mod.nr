use std::static_assert;

use crate::{
    context::unconstrained_context::UnconstrainedContext, oracle::note_discovery::deliver_note,
    utils::array,
};

use dep::protocol_types::{
    address::AztecAddress,
    constants::{MAX_NOTE_HASHES_PER_TX, PRIVATE_LOG_SIZE_IN_FIELDS},
    hash::compute_note_hash_nonce,
};

// We reserve two fields in the note log that are not part of the packed note: one for the storage slot, and one for
// the note type id.
global NOTE_LOG_RESERVED_FIELDS: u32 = 2;
pub global MAX_NOTE_PACKED_LEN: u32 = PRIVATE_LOG_SIZE_IN_FIELDS - NOTE_LOG_RESERVED_FIELDS;

pub struct NoteHashesAndNullifier {
    pub note_hash: Field,
    pub unique_note_hash: Field,
    pub inner_nullifier: Field,
}

/// Processes a log given its plaintext by trying to find notes encoded in it. This process involves the discovery of
/// the nonce of any such notes, which requires knowledge of the transaction hash in which the notes would've been
/// created, along with the list of unique note hashes in said transaction.
///
/// Additionally, this requires a `compute_note_hash_and_nullifier` lambda that is able to compute these values for any
/// note type in the contract given the packed note. A typical implementation of such a function would look like this:
///
/// ```
/// |packed_note, note_header, note_type_id| {
///     let hashes = if note_type_id == MyNoteType::get_note_type_id() {
///         assert(packed_note.len() == MY_NOTE_TYPE_PACKED_LENGTH);
///         dep::aztec::note::utils::compute_note_hash_and_optionally_a_nullifier(
///             MyNoteType::unpack,
///             contract_address,
///             nonce,
///             storage_slot,
///             packed_note.storage(),
///         )
///     } else {
///         panic(f"Unknown note type id {note_type_id}")
///     };
///
///     Option::some(dep::aztec::oracle::management::NoteHashesAndNullifier {
///         note_hash: hashes[0],
///         unique_note_hash: hashes[1],
///         inner_nullifier: hashes[3],
///     })
/// }
/// ```
pub unconstrained fn do_process_log<Env>(
    context: UnconstrainedContext,
    log_plaintext: BoundedVec<Field, PRIVATE_LOG_SIZE_IN_FIELDS>,
    tx_hash: Field,
    unique_note_hashes_in_tx: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    first_nullifier_in_tx: Field,
    recipient: AztecAddress,
    compute_note_hash_and_nullifier: fn[Env](BoundedVec<Field, MAX_NOTE_PACKED_LEN>, AztecAddress, Field, Field, Field) -> Option<NoteHashesAndNullifier>,
) {
    let (storage_slot, note_type_id, packed_note) = destructure_log_plaintext(log_plaintext);

    // We need to find the note's nonce, which is the one that results in one of the unique note hashes from tx_hash
    for_each_in_bounded_vec(
        unique_note_hashes_in_tx,
        |expected_unique_note_hash, i| {
            let candidate_nonce = compute_note_hash_nonce(first_nullifier_in_tx, i);

            // TODO(#11157): handle failed note_hash_and_nullifier computation
            let hashes = compute_note_hash_and_nullifier(
                packed_note,
                context.this_address(),
                candidate_nonce,
                storage_slot,
                note_type_id,
            )
                .unwrap();

            if hashes.unique_note_hash == expected_unique_note_hash {
                // TODO(#10726): push these into a vec to deliver all at once instead of having one oracle call per note

                assert(
                    deliver_note(
                        context.this_address(), // TODO(#10727): allow other contracts to deliver notes
                        storage_slot,
                        candidate_nonce,
                        packed_note,
                        hashes.note_hash,
                        hashes.inner_nullifier,
                        tx_hash,
                        recipient,
                    ),
                    "Failed to deliver note",
                );

                // We don't exit the loop - it is possible (though rare) for the exact same packed note to be present
                // multiple times in the same transaction with different nonces. This typically doesn't happen due to
                // notes containing random values in order to protect against note hash preimage attacks.
            }
        },
    );
}

unconstrained fn destructure_log_plaintext(
    log_plaintext: BoundedVec<Field, PRIVATE_LOG_SIZE_IN_FIELDS>,
) -> (Field, Field, BoundedVec<Field, MAX_NOTE_PACKED_LEN>) {
    assert(log_plaintext.len() >= NOTE_LOG_RESERVED_FIELDS);

    // If NOTE_LOG_RESERVED_FIELDS is changed, causing the assertion below to fail, then the declarations for
    // `storage_slot` and `note_type_id` must be updated as well.
    static_assert(
        NOTE_LOG_RESERVED_FIELDS == 2,
        "unexpected value for NOTE_LOG_RESERVED_FIELDS",
    );
    let storage_slot = log_plaintext.get(0);
    let note_type_id = log_plaintext.get(1);

    let packed_note = array::subbvec(log_plaintext, NOTE_LOG_RESERVED_FIELDS);

    (storage_slot, note_type_id, packed_note)
}

fn for_each_in_bounded_vec<T, let MaxLen: u32, Env>(
    vec: BoundedVec<T, MaxLen>,
    f: fn[Env](T, u32) -> (),
) {
    for i in 0..MaxLen {
        if i < vec.len() {
            f(vec.get_unchecked(i), i);
        }
    }
}
