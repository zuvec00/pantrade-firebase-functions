import {calculateServiceCharge} from "./fees.utils";

/**
 * Test suite for service charge calculation
 * Formula: 5.5% + ₦100, capped at ₦2000
 */

interface TestCase {
  subtotal: number;
  expected: number;
  description: string;
}

const testCases: TestCase[] = [
  // Basic calculations
  {
    subtotal: 0,
    expected: 100, // 0 * 0.055 + 100 = 100
    description: "Zero subtotal should return base fee of ₦100",
  },
  {
    subtotal: 1000,
    expected: 155, // 1000 * 0.055 + 100 = 55 + 100 = 155
    description: "₦1,000 subtotal",
  },
  {
    subtotal: 2000,
    expected: 210, // 2000 * 0.055 + 100 = 110 + 100 = 210
    description: "₦2,000 subtotal",
  },
  {
    subtotal: 5000,
    expected: 375, // 5000 * 0.055 + 100 = 275 + 100 = 375
    description: "₦5,000 subtotal",
  },
  {
    subtotal: 10000,
    expected: 650, // 10000 * 0.055 + 100 = 550 + 100 = 650
    description: "₦10,000 subtotal",
  },
  {
    subtotal: 20000,
    expected: 1200, // 20000 * 0.055 + 100 = 1100 + 100 = 1200
    description: "₦20,000 subtotal",
  },
  // Cap testing - at exactly the cap threshold
  {
    subtotal: 34545.45, // (34545.45 * 0.055) + 100 ≈ 2000
    expected: 2000,
    description: "Subtotal at cap threshold (~₦34,545)",
  },
  // Above cap
  {
    subtotal: 35000,
    expected: 2000, // Would be 2025, but capped at 2000
    description: "₦35,000 subtotal (above cap, should return ₦2,000)",
  },
  {
    subtotal: 40000,
    expected: 2000, // Would be 2300, but capped at 2000
    description: "₦40,000 subtotal (above cap)",
  },
  {
    subtotal: 50000,
    expected: 2000, // Would be 2850, but capped at 2000
    description: "₦50,000 subtotal (well above cap)",
  },
  {
    subtotal: 100000,
    expected: 2000, // Would be 5600, but capped at 2000
    description: "₦100,000 subtotal (far above cap)",
  },
  // Edge cases
  {
    subtotal: 100,
    expected: 105.5, // 100 * 0.055 + 100 = 5.5 + 100 = 105.5
    description: "Small subtotal ₦100",
  },
  {
    subtotal: 500,
    expected: 127.5, // 500 * 0.055 + 100 = 27.5 + 100 = 127.5
    description: "Small subtotal ₦500",
  },
];

// Run tests
console.log("🧪 Running Service Charge Tests...\n");
console.log("=" .repeat(70));
console.log("Formula: 5.5% + ₦100, capped at ₦2,000");
console.log("=" .repeat(70) + "\n");

let passed = 0;
let failed = 0;

testCases.forEach((testCase, index) => {
  const result = calculateServiceCharge(testCase.subtotal);
  const isPass = Math.abs(result - testCase.expected) < 0.01; // Allow for floating point precision

  if (isPass) {
    passed++;
    console.log(`✅ Test ${index + 1}: PASSED`);
  } else {
    failed++;
    console.log(`❌ Test ${index + 1}: FAILED`);
  }

  console.log(`   ${testCase.description}`);
  console.log(`   Subtotal: ₦${testCase.subtotal.toLocaleString()}`);
  console.log(`   Expected: ₦${testCase.expected.toLocaleString()}`);
  console.log(`   Got:      ₦${result.toLocaleString()}`);
  console.log("");
});

console.log("=" .repeat(70));
console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed out of ${testCases.length} tests\n`);

// Validation test: Ensure server validation logic will work
console.log("=" .repeat(70));
console.log("🔍 Testing Server Validation Logic");
console.log("=" .repeat(70) + "\n");

// Simulate the validation from order.utils.ts (line 65)
const validationTests = [
  {subtotal: 5000, clientFee: 375, shouldPass: true},
  {subtotal: 5000, clientFee: 374, shouldPass: true}, // Within tolerance
  {subtotal: 5000, clientFee: 376, shouldPass: true}, // Within tolerance
  {subtotal: 5000, clientFee: 370, shouldPass: false}, // Outside tolerance
  {subtotal: 5000, clientFee: 380, shouldPass: false}, // Outside tolerance
  {subtotal: 35000, clientFee: 2000, shouldPass: true},
  {subtotal: 35000, clientFee: 2001, shouldPass: true}, // Within tolerance
  {subtotal: 35000, clientFee: 1999, shouldPass: true}, // Within tolerance
  {subtotal: 35000, clientFee: 1995, shouldPass: false}, // Outside tolerance
];

let validationPassed = 0;
let validationFailed = 0;

validationTests.forEach((test, index) => {
  const serverCalculated = calculateServiceCharge(test.subtotal);
  const isWithinTolerance = Math.abs(serverCalculated - test.clientFee) <= 1;
  const testPassed = isWithinTolerance === test.shouldPass;

  if (testPassed) {
    validationPassed++;
    console.log(`✅ Validation Test ${index + 1}: PASSED`);
  } else {
    validationFailed++;
    console.log(`❌ Validation Test ${index + 1}: FAILED`);
  }

  console.log(`   Subtotal: ₦${test.subtotal.toLocaleString()}`);
  console.log(`   Server calculated: ₦${serverCalculated.toLocaleString()}`);
  console.log(`   Client sent: ₦${test.clientFee.toLocaleString()}`);
  console.log(`   Difference: ₦${Math.abs(serverCalculated - test.clientFee).toFixed(2)}`);
  console.log(`   Should ${test.shouldPass ? "PASS" : "FAIL"} validation: ${testPassed ? "✓" : "✗"}`);
  console.log("");
});

console.log("=" .repeat(70));
console.log(`\n📊 Validation Results: ${validationPassed} passed, ${validationFailed} failed out of ${validationTests.length} tests\n`);

// Overall summary
const totalTests = testCases.length + validationTests.length;
const totalPassed = passed + validationPassed;
const totalFailed = failed + validationFailed;

console.log("=" .repeat(70));
console.log("🎯 OVERALL SUMMARY");
console.log("=" .repeat(70));
console.log(`Total Tests: ${totalTests}`);
console.log(`Passed: ${totalPassed}`);
console.log(`Failed: ${totalFailed}`);
console.log(`Success Rate: ${((totalPassed / totalTests) * 100).toFixed(2)}%`);
console.log("=" .repeat(70) + "\n");

// Exit with appropriate code
if (totalFailed > 0) {
  console.log("❌ Some tests failed!");
  process.exit(1);
} else {
  console.log("✅ All tests passed!");
  process.exit(0);
}

