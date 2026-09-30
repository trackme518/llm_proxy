import { sentenceSplit } from "../chunking.js";
/**
 * Test script for sentence splitting with abbreviation handling
 * Heuristic Strategy: Detect abbreviations by characteristics (length, caps, patterns)
 */

// Test cases - Czech and English mixed
const testCases = [
  // === CZECH TESTS ===
  {
    description: "Czech: Simple sentence with MgA.",
    input: "MgA. Novák přišel do kanceláře.",
    expected: ["MgA. Novák přišel do kanceláře."]
  },
  {
    description: "Czech: Multiple sentences with titles",
    input: "Ing. Svoboda zahájil jednání. PhDr. Černá představila projekt. Výsledky byly pozitivní.",
    expected: ["Ing. Svoboda zahájil jednání.", "PhDr. Černá představila projekt.", "Výsledky byly pozitivní."]
  },
  {
    description: "Czech: Company s.r.o. in text",
    input: "Společnost ABC s.r.o. byla založena v roce 1995. Dnes má 50 zaměstnanců.",
    expected: ["Společnost ABC s.r.o. byla založena v roce 1995.", "Dnes má 50 zaměstnanců."]
  },
  {
    description: "Czech: Multiple academic titles",
    input: "Doc. RNDr. Novák, CSc. vedl výzkum. Jeho tým publikoval výsledky.",
    expected: ["Doc. RNDr. Novák, CSc. vedl výzkum.", "Jeho tým publikoval výsledky."]
  },
  {
    description: "Czech: Questions and exclamations",
    input: "Kde je Dr. Horák? Je to úžasné! MgA. Malá souhlasí.",
    expected: ["Kde je Dr. Horák?", "Je to úžasné!", "MgA. Malá souhlasí."]
  },
  {
    description: "Czech: Complex business text",
    input: "Firma Novák a syn s.r.o. uzavřela smlouvu. Partner XYZ a.s. podepsal dokumenty. Jednání proběhlo úspěšně.",
    expected: ["Firma Novák a syn s.r.o. uzavřela smlouvu.", "Partner XYZ a.s. podepsal dokumenty.", "Jednání proběhlo úspěšně."]
  },
  {
    description: "Czech: Legal titles",
    input: "JUDr. Dvořák zastupoval klienta. Mgr. Procházková připravila smlouvu.",
    expected: ["JUDr. Dvořák zastupoval klienta.", "Mgr. Procházková připravila smlouvu."]
  },
  {
    description: "Czech: Medical context",
    input: "MUDr. Král provedl vyšetření. Prof. MUDr. Novotný, CSc. potvrdil diagnózu.",
    expected: ["MUDr. Král provedl vyšetření.", "Prof. MUDr. Novotný, CSc. potvrdil diagnózu."]
  },
  
  // === ENGLISH TESTS ===
  {
    description: "English: Simple sentence with Dr.",
    input: "Dr. Smith arrived at the hospital.",
    expected: ["Dr. Smith arrived at the hospital."]
  },
  {
    description: "English: Multiple sentences with titles",
    input: "Prof. Johnson presented the findings. Dr. Williams asked questions. The debate continued.",
    expected: ["Prof. Johnson presented the findings.", "Dr. Williams asked questions.", "The debate continued."]
  },
  {
    description: "English: Company names",
    input: "Microsoft Corp. announced results. Apple Inc. followed suit.",
    expected: ["Microsoft Corp. announced results.", "Apple Inc. followed suit."]
  },
  {
    description: "English: Academic degrees",
    input: "John Smith, Ph.D. published a paper. Mary Johnson, M.D. reviewed it.",
    expected: ["John Smith, Ph.D. published a paper.", "Mary Johnson, M.D. reviewed it."]
  },
  {
    description: "English: Mixed punctuation",
    input: "What happened? Mr. Brown knows! He told Mrs. Davis.",
    expected: ["What happened?", "Mr. Brown knows!", "He told Mrs. Davis."]
  },
  
  // === MIXED CZECH/ENGLISH ===
  {
    description: "Mixed: Czech and English in same text",
    input: "Dr. Smith met with MgA. Novák. They discussed the project by ABC s.r.o. The collaboration was successful.",
    expected: ["Dr. Smith met with MgA. Novák.", "They discussed the project by ABC s.r.o.", "The collaboration was successful."]
  },
  {
    description: "Mixed: Business context",
    input: "Our partner Tech s.r.o. signed with Microsoft Corp. Prof. Černý approved the deal.",
    expected: ["Our partner Tech s.r.o. signed with Microsoft Corp.", "Prof. Černý approved the deal."]
  },
  
  // === EDGE CASES ===
  {
    description: "Edge: Abbreviation at end",
    input: "He works for IBM Inc.",
    expected: ["He works for IBM Inc."]
  },
  {
    description: "Edge: Numbers in text",
    input: "Firma vznikla v r. 1990. Dnes má pobočky.",
    expected: ["Firma vznikla v r. 1990.", "Dnes má pobočky."]
  },
  {
    description: "Edge: Multiple periods in abbreviation",
    input: "Společnost a.s. spolupracuje s o.p.s. Projekt pokračuje.",
    expected: ["Společnost a.s. spolupracuje s o.p.s.", "Projekt pokračuje."]
  },
  {
    description: "Edge: Single sentence with many titles",
    input: "MgA. Novák, Ing. Svoboda, Ph.D., a Dr. Smith diskutovali.",
    expected: ["MgA. Novák, Ing. Svoboda, Ph.D., a Dr. Smith diskutovali."]
  }
];

// Run tests
console.log("🧪 Testing Sentence Splitting Strategy 2 (Lookbehind)\n");
console.log("=" .repeat(80));

let passedTests = 0;
let failedTests = 0;

testCases.forEach((test, index) => {
  const result = sentenceSplit(test.input);
  const resultText = result.map((item: { text: string }) => item.text.trimStart());
  const passed = JSON.stringify(resultText) === JSON.stringify(test.expected);
  
  if (passed) {
    passedTests++;
    console.log(`✅ Test ${index + 1}: ${test.description}`);
  } else {
    failedTests++;
    console.log(`❌ Test ${index + 1}: ${test.description}`);
    console.log(`   Input:    "${test.input}"`);
    console.log(`   Expected: ${JSON.stringify(test.expected)}`);
    console.log(`   Got:      ${JSON.stringify(resultText)}`);
    console.log(`   Raw:      ${JSON.stringify(result)}`);
  }
});

console.log("\n" + "=".repeat(80));
console.log(`📊 Results: ${passedTests} passed, ${failedTests} failed out of ${testCases.length} tests`);

if (failedTests === 0) {
  console.log("✅ All tests passed!");
} else {
  console.log("⚠️  Some tests failed. Review the regex or adjust expectations.");
}

// Manual testing section
console.log("\n" + "=".repeat(80));
console.log("Manual Test Area\n");

const manualTests = [
  "Zprava od paláce pánů z Lissau čp. 935 až k bývalému paulánskému klášteru čp. 930. Dvorní křídla byla pronajímaná k bydlení i provozu živností. V domě čp. 933 zvaném Goltzovský si zařídil ve druhém dvoře svoji litografickou dílnu v letech 1819–1820 také mladý Antonín Langweil a pravděpodobně zde i s rodinou bydlel.",
  "narodil se 3. 12. 2001",
  "Je slepic 30? To nevím.",
  "Setkání se uskutečnilo v Praze 5. března 2023.",
  "Prof. Dr. Müller přednášel na univerzitě.",
  "Společnost XYZ a.s. oznámila výsledky.",
  "Kde je Dr. Horák? Je to úžasné! MgA. Malá souhlasí.",
  "MgA. Vojtěch Leischner PhD. je joudelín a používá regex co rozbili cloudflare.",
  "To je vše, co jsem chtěl říct... Děkuji vám!",
];

manualTests.forEach(text => {
  console.log(`Input:  "${text}"`);
  console.log(`Result: ${JSON.stringify(sentenceSplit(text))}\n`);
});
