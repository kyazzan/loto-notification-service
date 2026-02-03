import admin from 'firebase-admin';
import path from 'path';

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saPath) throw new Error('FIREBASE_SERVICE_ACCOUNT env is missing');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const serviceAccount = require(path.resolve(saPath));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  initialized = true;
}

export function fcm() {
  initFirebase();
  return admin.messaging();
}
