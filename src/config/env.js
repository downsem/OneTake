export const env = {
  firebaseApiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  firebaseAuthDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  firebaseProjectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  firebaseStorageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  firebaseMessagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  firebaseAppId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

export function hasFirebaseEnv() {
  return Boolean(
    env.firebaseApiKey &&
      env.firebaseAuthDomain &&
      env.firebaseProjectId &&
      env.firebaseStorageBucket &&
      env.firebaseMessagingSenderId &&
      env.firebaseAppId
  );
}
