import { addDoc, collection, onSnapshot, orderBy, query, serverTimestamp, updateDoc, doc } from 'firebase/firestore';
import { db } from '../lib/firebase';

export async function submitPromptSuggestion(text, submittedByUid) {
  if (!text?.trim()) throw new Error('Suggestion text is required.');
  return addDoc(collection(db, 'promptSuggestions'), {
    text: text.trim(),
    submittedByUid,
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
  await updateDoc(doc(db, 'promptSuggestions', suggestionId), {
    status,
    reviewedByAdminUid: adminUid,
    reviewedAtClient: Date.now(),
    updatedAt: serverTimestamp(),
  });
}
