import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from './firebase';

export async function uploadVideoForUser({ userId, localUri }) {
  if (!userId) throw new Error('Missing userId');
  if (!localUri) throw new Error('Missing localUri');

  const response = await fetch(localUri);
  const blob = await response.blob();

  const filename = `${Date.now()}.mp4`;
  const storagePath = `users/${userId}/takes/${filename}`;
  const fileRef = ref(storage, storagePath);

  await uploadBytes(fileRef, blob, { contentType: 'video/mp4' });
  const downloadURL = await getDownloadURL(fileRef);

  return { storagePath, downloadURL };
}
