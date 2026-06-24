import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

export async function logEvent(eventName, user = null, properties = {}) {
  try {
    if (!eventName || !user?.uid) return;

    await addDoc(collection(db, 'analyticsEvents'), {
      name: eventName,
      eventName,
      uid: user.uid,
      email: user?.email || null,
      properties: properties || {},
      createdAt: serverTimestamp(),
      createdAtClient: Date.now(),
    });
  } catch (error) {
    console.log('analytics log failed', error?.message || error);
  }
}
