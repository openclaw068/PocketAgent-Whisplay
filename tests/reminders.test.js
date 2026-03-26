// Simple tests for the fixes

import { scoreMatch, bestReminderMatch } from '../pocketagent/match.js';

console.log('=== Testing Match Function ===\n');

// Test 1: Basic matching for "trash"
const testReminders = [
  { id: '1', text: 'Take out the trash', dueAtIso: '2024-01-01T10:00:00Z' },
  { id: '2', text: 'Buy groceries', dueAtIso: '2024-01-01T12:00:00Z' },
  { id: '3', text: 'Garbage day Wednesday', dueAtIso: '2024-01-02T10:00:00Z' },
];

console.log('Test: "trash" against reminders');
for (const r of testReminders) {
  const score = scoreMatch({ query: 'trash', text: r.text });
  console.log(`  "${r.text}" -> score: ${score}`);
}

const { best, bestScore } = bestReminderMatch({ reminders: testReminders, queryText: 'trash' });
console.log(`\nBest match: "${best?.text}" with score ${bestScore}`);
console.log(`Expected: "Take out the trash" (score should be >= 25 for auto-ack)`);

// Test 2: "mark the reminder about trash as done" - this tests router-like extraction
console.log('\n=== Testing Router Extraction Simulation ===\n');

// Simulate what the router would extract
const userInput = 'mark the reminder about trash as done';
const ackText = 'trash'; // This is what the router should extract

const { best: match2, bestScore: score2 } = bestReminderMatch({ 
  reminders: testReminders, 
  queryText: ackText 
});
console.log(`User said: "${userInput}"`);
console.log(`Extracted ackText: "${ackText}"`);
console.log(`Match result: "${match2?.text}" (score: ${score2})`);

// Test 3: Verify confidence threshold
console.log('\n=== Testing Confidence Threshold ===\n');
const threshold = 25;
const ambiguousInput = 'reminder';
const { best: match3, bestScore: score3 } = bestReminderMatch({
  reminders: testReminders,
  queryText: ambiguousInput
});
console.log(`Query: "${ambiguousInput}"`);
console.log(`Best match: "${match3?.text}" (score: ${score3})`);
console.log(`Would trigger clarification? ${score3 < threshold ? 'YES (score < 25)' : 'NO'}`);

// Test 4: Overdue reminder sorting
console.log('\n=== Testing Reminder Sorting (Most Recent) ===\n');

// Simulate the say-next-reminder.sh logic
const reminders = [
  { text: 'Early reminder', dueAtIso: '2024-01-01T08:00:00Z' },
  { text: 'Middle reminder', dueAtIso: '2024-01-01T12:00:00Z' },
  { text: 'Late reminder', dueAtIso: '2024-01-01T18:00:00Z' },
];

// Original (earliest first)
const earliest = [...reminders].sort((a, b) => new Date(a.dueAtIso) - new Date(b.dueAtIso))[0];
console.log(`Original (earliest): "${earliest.text}"`);

// Fixed (most recent - last in sorted array)
const mostRecent = [...reminders].sort((a, b) => new Date(a.dueAtIso) - new Date(b.dueAtIso)).pop();
console.log(`Fixed (most recent): "${mostRecent.text}"`);

console.log('\n=== All Tests Complete ===');