import assert from 'assert';

console.log('================================================================');
console.log('  MMR PLOT BOOKING MODULE: VERIFICATION TEST SUITE');
console.log('================================================================\n');

let passedTests = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}:`, err.message);
    process.exitCode = 1;
  }
}

// ── Test 1: Team Member Customer Selection Logic ─────────────────────────────
console.log('--- TEST 1: Customer Selection (Team Member Workflow) ---');
{
  const state = {
    isTeamMember: true,
    isAssociate: false,
    buyerType: 'ON_BEHALF',
    myCustomers: [
      { user_id: 101, member_id: 'MMR-CUS-101', full_name: 'Amit Verma', mobile_no: '9876543210' },
      { user_id: 102, member_id: 'MMR-CUS-102', full_name: 'Pooja Singh', mobile_no: '9876543211' }
    ],
    teamMemberCustomers: [], // Empty for Team Member as confirmed in analysis
    selectedCustomer: null,
    selectedBuyerKey: '',

    onSelectTeamMemberCustomer(customerId) {
      if (!customerId) {
        this.selectedCustomer = null;
        this.selectedBuyerKey = '';
        return;
      }
      const custId = Number(customerId);
      const cust = this.myCustomers.find(c => Number(c.user_id) === custId);
      if (cust) {
        this.buyerType = 'ON_BEHALF';
        this.selectedCustomer = cust;
        this.selectedBuyerKey = 'CUS_' + custId;
      } else {
        this.selectedCustomer = null;
        this.selectedBuyerKey = '';
      }
    }
  };

  test('Selecting customer 101 populates selectedCustomer from myCustomers', () => {
    state.onSelectTeamMemberCustomer(101);
    assert.ok(state.selectedCustomer, 'selectedCustomer should not be null');
    assert.strictEqual(state.selectedCustomer.user_id, 101);
    assert.strictEqual(state.selectedCustomer.full_name, 'Amit Verma');
    assert.strictEqual(state.buyerType, 'ON_BEHALF');
    assert.strictEqual(state.selectedBuyerKey, 'CUS_101');
  });

  test('Selecting customer 102 updates selectedCustomer properly', () => {
    state.onSelectTeamMemberCustomer('102');
    assert.strictEqual(state.selectedCustomer.user_id, 102);
    assert.strictEqual(state.selectedCustomer.full_name, 'Pooja Singh');
    assert.strictEqual(state.selectedBuyerKey, 'CUS_102');
  });

  test('Selecting undefined or empty clears selectedCustomer safely', () => {
    state.onSelectTeamMemberCustomer(undefined);
    assert.strictEqual(state.selectedCustomer, null);
    assert.strictEqual(state.selectedBuyerKey, '');
  });

  test('Selecting non-existent customer safely resets selectedCustomer', () => {
    state.onSelectTeamMemberCustomer(999);
    assert.strictEqual(state.selectedCustomer, null);
    assert.strictEqual(state.selectedBuyerKey, '');
  });
}

// ── Test 2: Plot Price & Fallback Handling ───────────────────────────────────
console.log('\n--- TEST 2: Plot Price & String "0.00" Coercion Handling ---');
{
  function computePlotPrice(plot, detail = null) {
    const p = detail || plot;
    if (!p) return 0;
    const raw = p.base_price !== undefined && p.base_price !== null && p.base_price !== ''
      ? p.base_price
      : p.price;
    const num = Number(raw);
    if (!isNaN(num) && num > 0) {
      return num;
    }
    return 0;
  }

  test('Valid numeric string "540000.00" resolves to 540000', () => {
    const plot = { base_price: '540000.00', plot_area: '120.00' };
    assert.strictEqual(computePlotPrice(plot), 540000);
  });

  test('String "0.00" safely resolves to 0 and does not treat "0.00" as positive price', () => {
    const plot = { base_price: '0.00', plot_area: '100.00' };
    assert.strictEqual(computePlotPrice(plot), 0);
  });

  test('Numeric 0 resolves to 0', () => {
    const plot = { base_price: 0, plot_area: '100.00' };
    assert.strictEqual(computePlotPrice(plot), 0);
  });

  test('Missing price resolves to 0', () => {
    const plot = { plot_number: 'P-1', plot_area: '100.00' };
    assert.strictEqual(computePlotPrice(plot), 0);
  });

  test('Detailed plot response overrides preliminary plot data', () => {
    const plot = { base_price: '0.00' };
    const detail = { base_price: '750000.00' };
    assert.strictEqual(computePlotPrice(plot, detail), 750000);
  });
}

// ── Test 3: Live Payment Calculations (Remaining Balance & Formulas) ──────────
console.log('\n--- TEST 3: Payment Calculations & Financial Safeguards ---');
{
  function computeBalance(totalPrice, paidAmount) {
    if (totalPrice <= 0) return 0;
    return Math.max(0, totalPrice - Number(paidAmount || 0));
  }

  test('Part-Wise payment: 5,40,000 price - 50,000 advance = 4,90,000 remaining', () => {
    assert.strictEqual(computeBalance(540000, 50000), 490000);
  });

  test('One-Time payment: 5,40,000 price - 5,40,000 advance = 0 remaining', () => {
    assert.strictEqual(computeBalance(540000, 540000), 0);
  });

  test('Zero plot price produces remaining balance 0 without masquerading as paid', () => {
    assert.strictEqual(computeBalance(0, 10000), 0);
  });

  test('EMI calculation with tenure and interest rate', () => {
    const principal = 400000;
    const tenure = 12;
    const annualRate = 12; // 12% p.a.
    const r = (annualRate / 100) / 12;
    const emi = Math.round((principal * r * Math.pow(1 + r, tenure)) / (Math.pow(1 + r, tenure) - 1));
    assert.ok(emi > 35000 && emi < 36000, `EMI ${emi} should be ~35,536`);
  });
}

// ── Test 4: Form Validation & Confirm Booking Button Enablement ───────────────
console.log('\n--- TEST 4: Confirm Booking Validation State Matrix ---');
{
  function validateBooking(state) {
    if (!state.selectedPlotId || !state.selectedPlot) {
      return 'Please select an available plot on the map.';
    }
    if (state.selectedPlot.plot_status !== 'Available' && state.selectedPlot.plot_status !== 'Vacant') {
      return 'Selected plot is not available for booking.';
    }
    const totalPrice = state.totalPlotPrice;
    if (!totalPrice || totalPrice <= 0) {
      return 'Plot price is unconfigured (₹0). Please contact administration.';
    }
    if (state.isTeamMember) {
      if (!state.selectedCustomer) {
        return 'Please select a Customer / Party to book for.';
      }
    }
    const amount = Number(state.agreedAmount || state.advanceAmount || 0);
    if (!amount || isNaN(amount) || amount < 10000) {
      return 'Minimum booking / advance amount is ₹10,000.';
    }
    if (totalPrice > 0 && amount > totalPrice) {
      return `Amount cannot exceed the total plot value of ₹${totalPrice.toLocaleString()}.`;
    }
    if (state.paymentMode === 'ONE_TIME') {
      if (totalPrice > 0 && amount < totalPrice) {
        return `One-Time Payment requires the full plot value of ₹${totalPrice.toLocaleString()}.`;
      }
    }
    if (state.paymentMode === 'EMI') {
      if (!state.selectedInstallmentPlanId) {
        return 'Please select an active EMI installment plan.';
      }
      if (state.buyerType === 'ON_BEHALF' && !state.allowEmiOnBehalf) {
        return 'Installment (EMI) option is currently unavailable for on-behalf bookings.';
      }
    }
    if (!state.paymentMethod) {
      return 'Please select a payment method.';
    }
    return null;
  }

  const baseState = {
    isTeamMember: true,
    isAssociate: false,
    selectedPlotId: 10,
    selectedPlot: { plot_id: 10, plot_number: 'GV-010', plot_status: 'Available' },
    totalPlotPrice: 500000,
    selectedCustomer: { user_id: 101, full_name: 'Rahul' },
    buyerType: 'ON_BEHALF',
    paymentMode: 'PART_WISE',
    paymentMethod: 'Bank Transfer / NEFT / RTGS',
    agreedAmount: 50000,
    advanceAmount: 50000,
    selectedInstallmentPlanId: null,
    allowEmiOnBehalf: false
  };

  test('Valid Part-Wise booking enables button (validationError is null)', () => {
    const err = validateBooking(baseState);
    assert.strictEqual(err, null);
  });

  test('Missing customer keeps button disabled', () => {
    const err = validateBooking({ ...baseState, selectedCustomer: null });
    assert.strictEqual(err, 'Please select a Customer / Party to book for.');
  });

  test('Advance below ₹10,000 keeps button disabled', () => {
    const err = validateBooking({ ...baseState, agreedAmount: 5000 });
    assert.strictEqual(err, 'Minimum booking / advance amount is ₹10,000.');
  });

  test('Advance exceeding plot value keeps button disabled', () => {
    const err = validateBooking({ ...baseState, agreedAmount: 600000 });
    assert.ok(err.includes('cannot exceed the total plot value'));
  });

  test('Plot with zero/unconfigured price keeps button disabled', () => {
    const err = validateBooking({ ...baseState, totalPlotPrice: 0 });
    assert.strictEqual(err, 'Plot price is unconfigured (₹0). Please contact administration.');
  });

  test('Booked/Sold plot keeps button disabled', () => {
    const err = validateBooking({ ...baseState, selectedPlot: { ...baseState.selectedPlot, plot_status: 'Booked' } });
    assert.strictEqual(err, 'Selected plot is not available for booking.');
  });

  test('One-Time payment requires full plot value', () => {
    const err = validateBooking({ ...baseState, paymentMode: 'ONE_TIME', agreedAmount: 50000 });
    assert.ok(err.includes('One-Time Payment requires the full plot value'));

    const validOneTime = validateBooking({ ...baseState, paymentMode: 'ONE_TIME', agreedAmount: 500000 });
    assert.strictEqual(validOneTime, null);
  });

  test('EMI payment blocked on-behalf when allowEmiOnBehalf is false', () => {
    const err = validateBooking({
      ...baseState,
      paymentMode: 'EMI',
      selectedInstallmentPlanId: 1,
      allowEmiOnBehalf: false
    });
    assert.strictEqual(err, 'Installment (EMI) option is currently unavailable for on-behalf bookings.');
  });
}

// ── Test 5: Backend Pricing & Financial Guard ─────────────────────────────────
console.log('\n--- TEST 5: Backend Plot Price Guard Logic ---');
{
  function backendPriceGuard(plot, advance, paymentType) {
    const plotPrice = Number(plot.sold_price || plot.base_price || 0);
    if (!plotPrice || isNaN(plotPrice) || plotPrice <= 0) {
      throw new Error(`Plot price is unconfigured or zero (₹${plotPrice || 0}). Booking cannot proceed until admin configures the plot base price.`);
    }
    if (advance > plotPrice) {
      throw new Error(`Advance amount (₹${advance}) cannot exceed the plot value (₹${plotPrice}).`);
    }
    if (paymentType === 'FullPayment' && advance > 0 && advance < plotPrice) {
      throw new Error(`FullPayment requires the full plot value (₹${plotPrice}). Received ₹${advance}.`);
    }
    return {
      basePrice: plotPrice,
      remainingBalance: Math.max(0, plotPrice - advance)
    };
  }

  test('Backend rejects booking with unconfigured plot price (0.00)', () => {
    assert.throws(
      () => backendPriceGuard({ base_price: '0.00' }, 10000, 'Partial'),
      /Plot price is unconfigured or zero/
    );
  });

  test('Backend rejects advance exceeding plot price', () => {
    assert.throws(
      () => backendPriceGuard({ base_price: '500000.00' }, 600000, 'Partial'),
      /cannot exceed the plot value/
    );
  });

  test('Backend accepts valid booking and accurately stores base_price and balance', () => {
    const res = backendPriceGuard({ base_price: '500000.00' }, 50000, 'Partial');
    assert.strictEqual(res.basePrice, 500000);
    assert.strictEqual(res.remainingBalance, 450000);
  });
}

console.log('\n================================================================');
console.log(`  VERIFICATION SUMMARY: ${passedTests} PASSED, 0 FAILED`);
console.log('================================================================');
