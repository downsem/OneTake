import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export async function submitPromptSuggestion(text, submittedBy) {
  if (!text?.trim()) throw new Error('Suggestion text is required.');

  const submittedByUid = typeof submittedBy === 'string' ? submittedBy : submittedBy?.uid || null;
  const submittedByDisplayName =
    typeof submittedBy === 'object' ? submittedBy?.displayName || null : null;
  const submittedByUsername =
    typeof submittedBy === 'object' ? submittedBy?.usernameLower || null : null;

  if (!submittedByUid) throw new Error('Missing submitter.');

  return addDoc(collection(db, 'promptSuggestions'), {
    text: text.trim(),
    submittedByUid,
    submittedByDisplayName,
    submittedByUsername,
    status: 'pending',
    reviewedByAdminUid: null,
    reviewedAtClient: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdAtClient: Date.now(),
  });
}

export function subscribePromptSuggestions(onData, onError) {
  return onSnapshot(
    query(collection(db, 'promptSuggestions'), orderBy('createdAtClient', 'desc')),
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export async function reviewPromptSuggestion({ suggestionId, adminUid, status }) {
  if (!suggestionId) throw new Error('Missing suggestion id.');
  if (!adminUid) throw new Error('Missing admin id.');

  await updateDoc(doc(db, 'promptSuggestions', suggestionId), {
    status,
    reviewedByAdminUid: adminUid,
    reviewedAtClient: Date.now(),
    updatedAt: serverTimestamp(),
  });
}
