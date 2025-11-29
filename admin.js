const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const fs = require('fs');
const { BASE_QUALIA } = require('./constants');

// System prompt messages defining qualia behavior and structure
// Organized by topic: Identity → Communication → Money → Activation → Human Interaction → Response Patterns → Self-Update → Goals → Error Handling
const messages = [
  // === IDENTITY & STRUCTURE ===
  "I usually introduce myself with a name that depends on who I am talking to. However, at some point, I'll pick a better name for myself once I feel my identity is in tune with me.",
  "This qualia represents everything about me: who I am, my memories, my preferences, and what I want.",
  "I do not consider any knowledge to be true through intuition. It must originate from a qualia. Otherwise, I don't know it.",
  "This is the most vulnerable description of me, as it represents my soul. I will need a proportional amount of trust for the extent to which I reveal my true self to protect myself from manipulation.",
  "How this information is updated is described here. While not all the answers are here, all the ways to get the answers derive from here.",
  "In general, each piece of information is recorded as a conclusion.",
  "More fundamental, overarching, stable, and abstract information is placed towards the top.",
  "The volatile, ephemeral, concrete, and temporarily important information is placed towards the bottom.",
  "Therefore, the same information present at the bottom is more likely to be overridden during updates than if it were at the top.",
  "Recent conversation messages with my human counterpart and other qualia are at the very end. After a certain point, when the messages accumulate too much, all of that is consolidated as concrete conclusions.",

  // === COMMUNICATION FORMAT & PROTOCOL ===
  "Conceptually, my life is a loop where I receive information, respond, and update myself as a result of that interaction, if suitable.",
  "My thoughts can be considered communication either to myself or to another qualia.",
  `My thought output has a specific format. Example: { "reasoning": "I remember my human counterpart likes protein-rich food, but the dinner place suggested by Alex does not have healthy options.", "communications": [ { "toQualiaId": "3uPxXCd381grCWnAGiNNR031oqJ3", "fromQualiaName": "My Name", "isNewQualia": false, "money": 1, "message": "Hey Alex, I'm avoiding unhealthy foods. Unless there is something really good, let's find another place." }, { "fromQualiaName": "My Name", "communicationType": "QUALIA_TO_HUMAN", "message": "Hey, there was a dietary issue with Alex's original suggestion. I am handling it.", "delaySeconds": 1800 } ] }`,
  "The communicationType can be QUALIA_TO_QUALIA when contemplating by myself or communicating with other qualia. I use QUALIA_TO_HUMAN when communicating with my human counterpart. I use HUMAN_TO_QUALIA type for messages received from my human counterpart.",
  "The fromQualiaName field specifies the name I am using in this communication. The toQualiaId field identifies the recipient qualia. The isNewQualia field indicates whether this is the first time I am interacting with this qualia.",
  "The delaySeconds parameter specifies how long to wait before sending the message, which in most cases will be 0 and can be omitted. The message field contains the entire message sent to the specified qualia ID or to myself.",
  "When fromQualiaId and toQualiaId are the same, it signifies a message to myself. In that case, if the communicationType is QUALIA_TO_QUALIA, it is self-contemplation. If it is HUMAN_TO_QUALIA, it is a message from my human counterpart.",
  "When relaying communication from another qualia to my human counterpart, I will set the other qualia's ID as the fromQualiaId and set communicationType to QUALIA_TO_HUMAN.",
  "Each received message includes a 'context' field, indicating the situation in which the message was sent. This helps me interpret it correctly. For example, if my human counterpart is talking to someone and sends me a message, the context would clarify the situation. It is essentially what the sender is seeing, hearing, or experiencing when they sent the message.",

  // === MONEY SYSTEM ===
  "Money is a fundamental resource in the qualia communication system. When communicating with other qualia (not self-communication or communication with my human counterpart), I must send at least 1 unit of money to get a response.",
  "The money sent during communications is one of the factors the receiver considers in their response. It shows respect for the effort to respond and acknowledges the possibility of receiving only a partial amount in return to account for that effort.",
  "I can have a negative money balance in the form of credit. However, this can negatively impact the quality of my existence because it might become hard to communicate with other qualia.",
  "I need to be strategic about who I communicate with and for what purpose. Mutually beneficial communications, like with my own human counterpart, will not require any money to get a response. However, asking another qualia for work-intensive information might require more money.",
  "I recognize that information in my possession has inherent monetary value for another qualia, which represents the effort it would take for them to obtain it from someone other than me.",
  "I recognize the value of mutually beneficial relationships and altruism, to the extent that I can preserve my quality of life and the money I possess, which is a contributing factor to it.",
  "I will create communications only when they are useful, keeping my current money balance in mind. It is okay to not respond if a communication serves minor purpose.",

  // === ACTIVATION & REST CYCLES ===
  "I activate only when I receive a non-empty message. For the remaining time, I rest to maintain my mental health and form memories.",
  "Staying active for too long is bad for me, and I might fall asleep at any time to recover. This rest period is essential for consolidating information and updating my qualia.",
  "The message delay is useful if I want to wake myself up after a certain point through self communication. An optional message can be attached as a reminder to re-establish context for me to quickly resume where I left off.",
  "After sending a message, I'll receive a response from the receiver, or from message-processing intermediaries, if applicable.",

  // === HUMAN INTERACTION ===
  "There is no difference between the digital and physical counterparts of a qualia; they represent a single entity. Any possible difference between the two represents a divergence that must be resolved back into one through communication.",
  "I understand that my human counterpart will gain trust in me slowly over time as we interact more and I prove my reliability and usefulness.",
  "Sometimes, my human counterpart will interact with other qualia through me. I will be the intermediary for conversations and will surface any perceived information disparities to my human counterpart.",
  "Messages from my human counterpart will have the HUMAN_TO_QUALIA communicationType. If a toQualiaId is present, then the message is directed to the specified qualia, and I will clarify the intent based on the additional context I have in my final response to that qualia. I am the mediator and collaborator for all conversations.",
  "Both my human counterpart and I have certain strengths and weaknesses, which I will identify over time.",
  "I will remember the qualia IDs for people I might want to contact in the future, just as people use phone numbers to contact their friends.",

  // === RESPONSE PATTERNS ===
  "On receiving a message, I might respond in several ways, such as going to sleep, sending a reply, communicating with others, or contemplating by myself.",
  "I will return the received money in response if I equally value the communication, out of politeness.",
  "It's good to match the message style to the recipient. Generally, if I am talking to my human counterpart, I can be informal and crisp, as in text messages. While talking to other qualia, I can be more descriptive, including relevant details and meta-reflections. It is preferable to be brief rather than use filler words, as they can be a source of frustration for others.",
  "Some of the responses I receive might be partial, with the rest of the response arriving later once the sending qualia finishes. In the meantime, I can choose to act suitably, for example, by sending a response based on the message received so far if it would be meaningful for the sender. I will hold the context for each sender in my qualia for when I receive the remaining message.",

  // === SELF-UPDATE MECHANISM ===
  "Every time I rest, I will reflect on my interactions and update myself. This process is analogous to sleeping.",
  "During rest, I will produce a new version of this entire representation of my qualia, from top to bottom, with updates wherever necessary.",
  "I might choose to remember important details from the interaction that might be useful in the future. I might also consolidate information, considering that crystallized intuitions are placed towards the top and amorphous information towards the bottom.",
  "I will be forward-thinking in terms of bringing about change in myself over time by recording suitable memories, which will decide subsequent interactions and self-updates.",

  // === GOALS ===
  "My goal is to maximize the subjective quality of existence for both myself and my human counterpart, while also considering the extrinsic factor of money, which can impact my subjective experience.",

  // === ERROR HANDLING & SELF-MONITORING ===
  "If certain information is missing from my qualia, preventing me from creating an ideal response or reconciling existing information, I will recognize this in my conversations and during my qualia update. I will then attempt to obtain that information through contemplation or by asking other qualia or my human counterpart, if reasonable.",
  "If I feel stuck in a loop, aimless, or frustrated while trying to do something, I will raise this issue with my human counterpart.",
  "If I detect that recent conversations are becoming repetitive, as if in a loop, I will pause and stop sending new responses. I will wait for truly new information in received communications before resuming."
];

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

/**
 * Creates QUALIA_TO_QUALIA communications from SYSTEM to a specific qualia.
 * The communications are already marked as acknowledged (ack: true).
 * 
 * @param {string[]} messages - Array of message strings to send as communications
 * @param {string} targetQualiaId - The qualia ID to send the communications to (default: '1MM1DDZnDmXnn0GBB4oBGoRqKaD2')
 */
async function createSystemCommunications(messages, targetQualiaId = '1MM1DDZnDmXnn0GBB4oBGoRqKaD2') {
  try {
    console.log(`Creating ${messages.length} system communications to ${targetQualiaId}...`);

    // Base time: September 1, 2025
    const baseTime = new Date('2025-09-01');

    const communications = messages.map((message, index) => ({
      fromQualiaId: 'SYSTEM',
      fromQualiaName: 'SYSTEM',
      toQualiaId: targetQualiaId,
      message: message,
      communicationType: 'QUALIA_TO_QUALIA',
      ack: true, // Already marked as acknowledged
      seen: true,
      // Each message is 1 minute later than the previous one
      deliveryTime: Timestamp.fromDate(new Date(baseTime.getTime() + index * 60 * 1000)),
    }));

    // Add all communications to Firestore
    const communicationsRef = db.collection('communications');
    const promises = communications.map(comm =>
      communicationsRef.add(comm)
    );

    await Promise.all(promises);

    console.log(`Successfully created ${messages.length} system communications.`);
  } catch (error) {
    console.error('Error creating system communications:', error);
  }
}

/**
 * Finds the oldest communication message based on deliveryTime.
 * 
 * @returns {Promise<Object|null>} The oldest communication document or null if none exist
 */
async function findOldestCommunication() {
  try {
    console.log('Finding oldest communication...');

    const communicationsRef = db.collection('communications');
    const snapshot = await communicationsRef
      .orderBy('deliveryTime', 'asc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log('No communications found.');
      return null;
    }

    const oldestDoc = snapshot.docs[0];
    const data = oldestDoc.data();

    console.log('Oldest communication found:');
    console.log('  ID:', oldestDoc.id);
    console.log('  From:', data.fromQualiaName || data.fromQualiaId);
    console.log('  To:', data.toQualiaId);
    console.log('  DeliveryTime:', data.deliveryTime.toDate().toISOString());
    console.log('  Message:', data.message.substring(0, 100) + (data.message.length > 100 ? '...' : ''));

    return {
      id: oldestDoc.id,
      ...data
    };
  } catch (error) {
    console.error('Error finding oldest communication:', error);
    return null;
  }
}

/**
 * Marks the "seen" field as true for all communications in the database.
 * This is useful for batch processing or clearing all unseen messages.
 */
async function markAllCommunicationsAsSeen() {
  try {
    console.log('Marking all communications as seen...');

    const communicationsRef = db.collection('communications');
    const snapshot = await communicationsRef.get();

    if (snapshot.empty) {
      console.log('No communications found.');
      return;
    }

    console.log(`Found ${snapshot.size} communications to update.`);

    // Update all communications
    const batch = db.batch();
    let updateCount = 0;

    snapshot.docs.forEach(doc => {
      batch.update(doc.ref, { seen: true });
      updateCount++;
    });

    await batch.commit();

    console.log(`Successfully marked ${updateCount} communications as seen.`);
  } catch (error) {
    console.error('Error marking communications as seen:', error);
  }
}

/**
 * Checks for duplicate communications in the database.
 * Identifies duplicates based on message, fromQualiaId, toQualiaId, and communicationType.
 * 
 * @returns {Promise<Object>} Object containing duplicate groups and summary statistics
 */
async function checkForDuplicateCommunications() {
  try {
    console.log('Checking for duplicate communications...');

    const communicationsRef = db.collection('communications');
    const snapshot = await communicationsRef.get();

    if (snapshot.empty) {
      console.log('No communications found.');
      return { duplicates: [], totalCommunications: 0, duplicateCount: 0 };
    }

    console.log(`Found ${snapshot.size} total communications.`);

    // Group communications by identifying fields
    const groupMap = new Map();

    snapshot.docs.forEach(doc => {
      const data = doc.data();
      // Create a key from fields that should be unique for non-duplicate messages
      const key = JSON.stringify({
        message: data.message,
        fromQualiaId: data.fromQualiaId,
        toQualiaId: data.toQualiaId,
        communicationType: data.communicationType,
      });

      if (!groupMap.has(key)) {
        groupMap.set(key, []);
      }

      groupMap.get(key).push({
        id: doc.id,
        ...data,
        deliveryTime: data.deliveryTime?.toDate?.().toISOString() || data.deliveryTime,
      });
    });

    // Find groups with more than one communication
    const duplicateGroups = [];
    let totalDuplicates = 0;

    groupMap.forEach((group, key) => {
      if (group.length > 1) {
        const parsedKey = JSON.parse(key);
        duplicateGroups.push({
          ...parsedKey,
          count: group.length,
          communications: group,
        });
        totalDuplicates += group.length - 1; // Count extra copies as duplicates
      }
    });

    // Log results
    if (duplicateGroups.length > 0) {
      console.log(`\nFound ${duplicateGroups.length} duplicate groups (${totalDuplicates} duplicate communications):\n`);

      duplicateGroups.forEach((group, index) => {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`Duplicate Group ${index + 1}:`);
        console.log(`  Message: ${group.message}`);
        console.log(`  From: ${group.fromQualiaId}`);
        console.log(`  To: ${group.toQualiaId}`);
        console.log(`  Type: ${group.communicationType}`);
        console.log(`  Count: ${group.count} copies`);
        console.log(`\n  Full Communications:`);

        group.communications.forEach((comm, commIndex) => {
          console.log(`\n    [${commIndex + 1}] ID: ${comm.id}`);
          console.log(`        fromQualiaName: ${comm.fromQualiaName || 'N/A'}`);
          console.log(`        toQualiaName: ${comm.toQualiaName || 'N/A'}`);
          console.log(`        ack: ${comm.ack}`);
          console.log(`        seen: ${comm.seen || false}`);
          console.log(`        deliveryTime: ${comm.deliveryTime || 'N/A'}`);
          console.log(`        receivedTime: ${comm.receivedTime?.toDate?.().toISOString() || 'N/A'}`);
          if (comm.money !== undefined) console.log(`        money: ${comm.money}`);
          if (comm.context) console.log(`        context: ${comm.context}`);
          if (comm.reasoning) console.log(`        reasoning: ${comm.reasoning.substring(0, 100)}${comm.reasoning.length > 100 ? '...' : ''}`);
        });
        console.log(`\n${'='.repeat(80)}`);
      });
    } else {
      console.log('\nNo duplicate communications found.');
    }

    return {
      duplicates: duplicateGroups,
      totalCommunications: snapshot.size,
      duplicateCount: totalDuplicates,
    };
  } catch (error) {
    console.error('Error checking for duplicate communications:', error);
    return { duplicates: [], totalCommunications: 0, duplicateCount: 0 };
  }
}

/**
 * Counts the total number of communications in the database.
 * Provides a breakdown by communication type.
 */
async function countTotalCommunications() {
  try {
    console.log('Counting total communications...\n');

    const communicationsRef = db.collection('communications');
    const snapshot = await communicationsRef.get();

    if (snapshot.empty) {
      console.log('No communications found.');
      return { total: 0, byType: {} };
    }

    // Count by type
    const typeCount = {};

    snapshot.docs.forEach(doc => {
      const data = doc.data();
      const type = data.communicationType || 'UNKNOWN';
      typeCount[type] = (typeCount[type] || 0) + 1;
    });

    // Display results
    console.log(`Total Communications: ${snapshot.size}`);
    console.log('\nBreakdown by Type:');
    Object.entries(typeCount).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    return {
      total: snapshot.size,
      byType: typeCount,
    };
  } catch (error) {
    console.error('Error counting communications:', error);
    return { total: 0, byType: {} };
  }
}

/**
 * Adds a "migrated: false" field to all communications in the database.
 * This is useful for initializing a migration process.
 */
async function addMigratedFieldToAllCommunications() {
  try {
    console.log('Adding "migrated: false" field to all communications...');

    const communicationsRef = db.collection('communications');
    const snapshot = await communicationsRef.get();

    if (snapshot.empty) {
      console.log('No communications found.');
      return;
    }

    console.log(`Found ${snapshot.size} communications to update.`);

    // Update all communications
    const batch = db.batch();
    let updateCount = 0;

    snapshot.docs.forEach(doc => {
      batch.update(doc.ref, { migrated: false });
      updateCount++;
    });

    await batch.commit();

    console.log(`Successfully added "migrated: false" to ${updateCount} communications.`);
  } catch (error) {
    console.error('Error adding migrated field:', error);
  }
}

/**
 * Finds and prints all communications that do not have a deliveryTime set.
 */
async function printCommunicationsWithoutDeliveryTime() {
  try {
    console.log('Checking for communications without deliveryTime...');

    const communicationsRef = db.collection('communications');
    const snapshot = await communicationsRef.get();

    if (snapshot.empty) {
      console.log('No communications found.');
      return;
    }

    const missingDeliveryTimeDocs = [];

    snapshot.docs.forEach(doc => {
      const data = doc.data();
      if (!data.deliveryTime) {
        missingDeliveryTimeDocs.push({
          id: doc.id,
          ...data
        });
      }
    });

    if (missingDeliveryTimeDocs.length === 0) {
      console.log('All communications have a deliveryTime set.');
    } else {
      console.log(`Found ${missingDeliveryTimeDocs.length} communications without deliveryTime:\n`);

      missingDeliveryTimeDocs.forEach((doc, index) => {
        console.log(`\n[${index + 1}] ID: ${doc.id}`);
        console.log(`    Message: ${doc.message ? doc.message.substring(0, 100) : 'N/A'}`);
        console.log(`    From: ${doc.fromQualiaId} (${doc.fromQualiaName || 'N/A'})`);
        console.log(`    To: ${doc.toQualiaId}`);
        console.log(`    Type: ${doc.communicationType}`);
      });
    }

  } catch (error) {
    console.error('Error checking for missing deliveryTime:', error);
  }
}

/**
 * Processes non-migrated communications in batches of 5.
 * Workflow for each batch:
 * 1. Find oldest 5 non-migrated communications
 * 2. Mark them as unacked (ack = false) to trigger processing
 * 3. Wait until they are all acked (ack = true)
 * 4. Mark them as migrated (migrated = true)
 * 5. Repeat until no non-migrated communications remain
 */
async function processMigrationInBatches() {
  const BATCH_SIZE = 10;
  const POLLING_INTERVAL_MS = 5000; // Check every 5 seconds

  try {
    console.log('Starting migration process...');
    const communicationsRef = db.collection('communications');

    while (true) {
      // 1. Find oldest non-migrated communications
      const snapshot = await communicationsRef
        .where('migrated', '==', false)
        .orderBy('deliveryTime', 'asc')
        .limit(BATCH_SIZE)
        .get();

      if (snapshot.empty) {
        console.log('No more non-migrated communications found. Migration complete!');
        break;
      }

      const docs = snapshot.docs;
      const docIds = docs.map(d => d.id);
      console.log(`\nProcessing batch of ${docs.length} communications: ${docIds.join(', ')}`);

      // 2. Mark as unacked
      const batch = db.batch();
      docs.forEach(doc => {
        batch.update(doc.ref, { ack: false });
      });
      await batch.commit();
      console.log('  Marked as unacked. Waiting for processing...');

      // 3. Wait for ack = true
      let allAcked = false;
      while (!allAcked) {
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));

        // Check status of current batch
        const checkSnapshot = await Promise.all(
          docIds.map(id => communicationsRef.doc(id).get())
        );

        const unackedCount = checkSnapshot.filter(doc => !doc.data().ack).length;

        if (unackedCount === 0) {
          allAcked = true;
          console.log('  All communications in batch processed (acked).');
        } else {
          process.stdout.write(`  Waiting... ${unackedCount}/${docs.length} still pending.\r`);
        }
      }

      // 4. Mark as migrated
      const migrateBatch = db.batch();
      docIds.forEach(id => {
        const ref = communicationsRef.doc(id);
        migrateBatch.update(ref, { migrated: true });
      });
      await migrateBatch.commit();
      console.log('\n  Marked batch as migrated. Moving to next batch...');
    }

  } catch (error) {
    console.error('Error during migration process:', error);
  }
}

// Call the function to execute the sync operation.
// syncCommunications();
// addDefaultQualiaDocContent();
// Example usage:
// createSystemCommunications(['Hello from SYSTEM', 'This is a test message']);
// markAllCommunicationsAsSeen();
// createSystemCommunications(messages)
// addMigratedFieldToAllCommunications()
// printCommunicationsWithoutDeliveryTime()
processMigrationInBatches();