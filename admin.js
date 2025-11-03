const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const { BASE_QUALIA } = require('./constants');

/**
 * Initialize the Firebase Admin SDK.
 *
 * When running in a Google Cloud environment (like Cloud Functions, App Engine,
 * or a GCE VM), the SDK can automatically discover the service account
 * credentials from the environment, so you don't need to provide them
 * explicitly. This is known as Application Default Credentials (ADC).
 *
 * For local development, you can set up ADC by running:
 * `gcloud auth application-default login`
 *
 * This command will store your user credentials in a well-known location on
 * your machine, and the Admin SDK will automatically find and use them.
 */
initializeApp();

const db = getFirestore();

/**
 * Reads data from a Firestore collection at a specific point in time in the past.
 * This uses Firestore's Point-in-Time Recovery (PITR) feature.
 *
 * Note: PITR must be enabled for your Firestore database. Data is available
 * for reads at a 1-minute granularity up to 7 days in the past.
 */
async function readPitrData() {
  try {
    // Define the point in time from which you want to read data.
    // This should be a timestamp within the last 7 days.
    // For this example, we'll read data from one hour ago.
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 120 * 60 * 1000);

    // The readTime must be a microsecond-precision timestamp in the past
    // and must be a whole minute.
    oneHourAgo.setSeconds(0, 0);

    console.log(`Attempting to read data from timestamp: ${oneHourAgo.toISOString()}`);

    // Replace 'your-collection-name' with the name of the collection you want to query.
    const collectionRef = db.collection('qualiaDocs');

    // You can create a query to filter the documents.
    // Replace 'some-field' and 'some-value' with your query parameters.
    // If you want to read all documents in the collection, you can just use collectionRef.
    const query = collectionRef.where('qualiaId', '==', '1MM1DDZnDmXnn0GBB4oBGoRqKaD2');

    // Perform the query with the `readTime` option.
    const snapshot = await query.get({ readTime: oneHourAgo });

    if (snapshot.empty) {
      console.log('No matching documents found at the specified point in time.');
      return;
    }

    const documents = [];
    snapshot.forEach(doc => {
      documents.push({ id: doc.id, data: doc.data() });
    });

    const outputFilePath = 'pitr-data.json';
    fs.writeFileSync(outputFilePath, JSON.stringify(documents, null, 2));
    console.log(`Successfully saved ${documents.length} documents to ${outputFilePath}`);

  } catch (error) {
    console.error('Error reading PITR data:', error);
    if (error.code === 'INVALID_ARGUMENT') {
        console.error('This might be because PITR is not enabled or the readTime is invalid.');
    }
  }
}

async function syncCommunications() {
  try {
    console.log('Starting communication sync...');

    // 1. Get all communications
    const communicationsSnapshot = await db.collection('communications').get();
    if (communicationsSnapshot.empty) {
      console.log('No documents found in communications collection.');
      return;
    }
    const allCommunications = communicationsSnapshot.docs.map(doc => doc.data());
    console.log('Found ' + allCommunications.length + ' communications.');

    // 2. Get the latest qualiaDoc for a specific qualiaId
    const qualiaDocsSnapshot = await db.collection('qualiaDocs')
      .where('qualiaId', '==', '1MM1DDZnDmXnn0GBB4oBGoRqKaD2')
      .where('nextQualiaDocId', '==', '')
      .limit(1)
      .get();

    if (qualiaDocsSnapshot.empty) {
      console.log('No qualiaDocs found for the specified qualiaId.');
      return;
    }
    const latestQualiaDoc = qualiaDocsSnapshot.docs[0];
    const qualiaDocData = latestQualiaDoc.data();
    console.log('Found latest qualiaDoc with id: ' + latestQualiaDoc.id);

    // 3. & 4. Create a Set of existing messages
    const existingMessages = new Set(qualiaDocData.content || []);
    console.log('QualiaDoc has ' + existingMessages.size + ' messages.');

    // 5. & 6. Find missing communications
    const missingCommunications = allCommunications.filter(comm => !existingMessages.has(comm.message));

    if (missingCommunications.length === 0) {
      console.log('No new communications to add. QualiaDoc is up to date.');
      return;
    }
    console.log('Found ' + missingCommunications.length + ' missing communications.');

    // 7. Add missing communications to the qualiaDoc
    const newMessages = missingCommunications.map(comm => comm.message);
    const updatedContent = (qualiaDocData.content || []).concat(newMessages);

    // 8. Update the qualiaDoc
    await latestQualiaDoc.ref.update({ content: updatedContent });

    console.log('Successfully added ' + missingCommunications.length + ' new communications to the qualia doc ' + latestQualiaDoc.id + '.');
  } catch (error) {
    console.error('Error syncing communications:', error);
  }
}


async function addDefaultQualiaDocContent() {
  try {
    console.log('Starting to add default qualia doc content...');

    // 1. Get the default content from constants.js
    const defaultContent = [BASE_QUALIA];
    console.log('Successfully read default content.');

    // 2. Get the latest qualiaDoc for a specific qualiaId
    const qualiaDocsSnapshot = await db.collection('qualiaDocs')
      .where('qualiaId', '==', '1MM1DDZnDmXnn0GBB4oBGoRqKaD2')
      .where('nextQualiaDocId', '==', '')
      .limit(1)
      .get();

    if (qualiaDocsSnapshot.empty) {
      console.log('No qualiaDocs found for the specified qualiaId.');
      return;
    }
    const latestQualiaDoc = qualiaDocsSnapshot.docs[0];
    const qualiaDocData = latestQualiaDoc.data();
    console.log('Found latest qualiaDoc with id: ' + latestQualiaDoc.id);

    // 3. Prepend the default content to the existing content
    const existingContent = qualiaDocData.content || [];
    const updatedContent = [...defaultContent, ...existingContent];

    // 4. Update the qualiaDoc
    await latestQualiaDoc.ref.update({ content: updatedContent });

    console.log('Successfully prepended default content to the qualia doc ' + latestQualiaDoc.id + '.');
  } catch (error) {
    console.error('Error adding default qualia doc content:', error);
  }
}

// Call the function to execute the sync operation.
syncCommunications();
// addDefaultQualiaDocContent();

