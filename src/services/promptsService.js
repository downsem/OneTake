import { db } from '../lib/firebase';
import { addDoc, collection, onSnapshot, orderBy, query, serverTimestamp } from 'firebase/firestore';

export function subscribeToPrompts(onData, onError) {
  const q = query(collection(db, 'prompts'), orderBy('createdAtClient', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      onData(items);
    },
    onError
  );
}

export async function createPrompt({ title, message, active, authorUid }) {
  return addDoc(collection(db, 'prompts'), {
    title: title || 'Untitled Prompt',
    message: message || '',
    active: !!active,
    createdAt: serverTimestamp(),
    createdAtClient: Date.now(),
    authorUid: authorUid || '',
  });
}
