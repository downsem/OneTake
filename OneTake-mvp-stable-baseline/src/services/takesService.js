import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export function subscribeToUserTakes(userId, onData, onError) {
  const takesRef = collection(db, 'users', userId, 'takes');
  const q = query(takesRef, orderBy('createdAtClient', 'desc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          localUri: data.localUri || '',
          source: data.source || 'unknown',
          createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
          createdAtClient: data.createdAtClient || 0,
          downloadURL: data.downloadURL || '',
          storagePath: data.storagePath || '',
        };
      });
      onData(items);
    },
    onError
  );
}

export async function createTake(userId, payload) {
  return addDoc(collection(db, 'users', userId, 'takes'), {
    localUri: payload.localUri || '',
    source: payload.source || 'unknown',
    downloadURL: payload.downloadURL || '',
    storagePath: payload.storagePath || '',
    createdAt: serverTimestamp(),
    createdAtClient: Date.now(),
  });
}

export async function deleteTakeDoc(userId, takeId) {
  return deleteDoc(doc(db, 'users', userId, 'takes', takeId));
}
