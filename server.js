const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Initialization
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
  }
});

// Setup DB Tables & Foreign Keys (tbl_users, tbl_vehicle_master, tbl_booking_details)
db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON;`);

  // 1. tbl_users
  db.run(`
    CREATE TABLE IF NOT EXISTS tbl_users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      mobile_no TEXT NOT NULL,
      password TEXT NOT NULL,
      kyc_verification_type TEXT DEFAULT 'Driving License',
      verification_details TEXT,
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. tbl_vehicle_master
  db.run(`
    CREATE TABLE IF NOT EXISTS tbl_vehicle_master (
      rent_id INTEGER PRIMARY KEY AUTOINCREMENT,
      rental_duration TEXT UNIQUE NOT NULL,
      scooters INTEGER NOT NULL,
      bikes INTEGER NOT NULL,
      sports_bike INTEGER NOT NULL,
      royal_enfield INTEGER NOT NULL
    )
  `, () => {
    // Seed rates from OGBikedb.xlsx if empty
    db.get('SELECT COUNT(*) as count FROM tbl_vehicle_master', (err, row) => {
      if (row && row.count === 0) {
        const stmt = db.prepare(`
          INSERT INTO tbl_vehicle_master (rent_id, rental_duration, scooters, bikes, sports_bike, royal_enfield)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(1, 'Daily', 499, 599, 999, 1199);
        stmt.run(2, 'Weekly', 2800, 3500, 4500, 7000);
        stmt.run(3, 'Monthly', 7500, 8000, 12000, 24000);
        stmt.finalize();
        console.log('Seeded tbl_vehicle_master rate tiers (Daily, Weekly, Monthly).');
      }
    });
  });

  // 3. tbl_booking_details with Foreign Keys
  db.run(`
    CREATE TABLE IF NOT EXISTS tbl_booking_details (
      trip_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      rent_id INTEGER NOT NULL,
      vehicle_type TEXT NOT NULL,
      usage_days INTEGER NOT NULL,
      total_cost INTEGER NOT NULL,
      booking_status TEXT DEFAULT 'Confirmed',
      payment_status TEXT DEFAULT 'Pending',
      booking_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES tbl_users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (rent_id) REFERENCES tbl_vehicle_master(rent_id) ON DELETE CASCADE
    )
  `);
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'og_bike_rentals_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    httpOnly: true
  }
}));

// Static files
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/videos', express.static(path.join(__dirname, 'videos')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// HTML Page Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ==========================================
// API ROUTES
// ==========================================

// Vehicle Master - Get Rates
app.get('/api/rates', (req, res) => {
  db.all('SELECT * FROM tbl_vehicle_master ORDER BY rent_id ASC', (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error.' });
    }
    res.json({ success: true, rates: rows });
  });
});

// Auth - Session Check
app.get('/api/auth/session', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      success: true,
      user: req.session.user
    });
  }
  return res.json({
    success: false,
    user: null
  });
});

// Auth - Signup
app.post('/api/auth/signup', (req, res) => {
  const { name, email, mobile, password, kycType, verificationDetails } = req.body;

  if (!name || !email || !password || !mobile) {
    return res.status(400).json({ success: false, message: 'All fields including mobile number are required.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const cleanMobile = mobile.trim();
  const kyc = kycType || 'Driving License';
  const vDetails = verificationDetails || '';

  // Check if user exists
  db.get('SELECT user_id FROM tbl_users WHERE email = ?', [normalizedEmail], (err, row) => {
    if (err) {
      console.error('Signup error:', err);
      return res.status(500).json({ success: false, message: 'Internal database error.' });
    }

    if (row) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run(
      'INSERT INTO tbl_users (user_name, email, mobile_no, password, kyc_verification_type, verification_details) VALUES (?, ?, ?, ?, ?, ?)',
      [name.trim(), normalizedEmail, cleanMobile, hashedPassword, kyc, vDetails],
      function (insertErr) {
        if (insertErr) {
          console.error('Insert user error:', insertErr);
          return res.status(500).json({ success: false, message: 'Failed to register account.' });
        }

        const newUser = {
          id: this.lastID,
          name: name.trim(),
          email: normalizedEmail,
          mobile: cleanMobile,
          kycType: kyc,
          verificationDetails: vDetails
        };
        req.session.userId = newUser.id;
        req.session.user = newUser;

        return res.json({
          success: true,
          message: 'Account created successfully!',
          user: newUser
        });
      }
    );
  });
});

// Auth - Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  db.get('SELECT * FROM tbl_users WHERE email = ?', [normalizedEmail], (err, user) => {
    if (err) {
      console.error('Login error:', err);
      return res.status(500).json({ success: false, message: 'Internal database error.' });
    }

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    const sessionUser = {
      id: user.user_id,
      name: user.user_name,
      email: user.email,
      mobile: user.mobile_no,
      kycType: user.kyc_verification_type,
      verificationDetails: user.verification_details
    };
    req.session.userId = user.user_id;
    req.session.user = sessionUser;

    return res.json({
      success: true,
      message: 'Sign in successful!',
      user: sessionUser
    });
  });
});

// Auth - Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Failed to sign out.' });
    }
    res.clearCookie('connect.sid');
    return res.json({ success: true, message: 'Signed out successfully.' });
  });
});

// Bookings - Get User History
app.get('/api/bookings', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
  }

  db.all(
    `SELECT b.trip_id as id, b.trip_id, b.user_id, b.rent_id, b.vehicle_type, b.usage_days as rental_days, 
            b.total_cost as total_price, b.booking_status as status, b.payment_status, b.booking_date,
            u.user_name, u.email, u.mobile_no, v.rental_duration
     FROM tbl_booking_details b
     JOIN tbl_users u ON b.user_id = u.user_id
     JOIN tbl_vehicle_master v ON b.rent_id = v.rent_id
     WHERE b.user_id = ?
     ORDER BY b.trip_id DESC`,
    [req.session.userId],
    (err, rows) => {
      if (err) {
        console.error('Fetch bookings error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch bookings.' });
      }
      return res.json({
        success: true,
        bookings: rows || []
      });
    }
  );
});

// Bookings - Submit Booking
app.post('/api/bookings', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
  }

  const { bikeType, rentalDays } = req.body;
  const days = parseInt(rentalDays, 10);

  if (!bikeType || isNaN(days) || days <= 0) {
    return res.status(400).json({ success: false, message: 'Valid bike selection and rental duration required.' });
  }

  // Determine rate tier from tbl_vehicle_master
  let rentId = 1; // Default Daily
  if (days >= 30) {
    rentId = 3; // Monthly
  } else if (days >= 7) {
    rentId = 2; // Weekly
  }

  db.get('SELECT * FROM tbl_vehicle_master WHERE rent_id = ?', [rentId], (err, masterRow) => {
    if (err || !masterRow) {
      console.error('Vehicle master fetch error:', err);
      return res.status(500).json({ success: false, message: 'Vehicle pricing error.' });
    }

    // Vehicle column mapping
    const vehicleKeyMap = {
      'Scooters': 'scooters',
      'Scooter': 'scooters',
      'Bikes': 'bikes',
      'Sports bike': 'sports_bike',
      'Sports Bike': 'sports_bike',
      'Royal Enfield': 'royal_enfield',
      'Adventure Bike': 'royal_enfield'
    };

    const colName = vehicleKeyMap[bikeType] || 'scooters';
    const unitPrice = masterRow[colName] || 499;

    let totalPrice = 0;
    if (rentId === 1) {
      totalPrice = unitPrice * days;
    } else if (rentId === 2) {
      const weeks = Math.ceil(days / 7);
      totalPrice = unitPrice * weeks;
    } else {
      const months = Math.ceil(days / 30);
      totalPrice = unitPrice * months;
    }

    db.run(
      'INSERT INTO tbl_booking_details (user_id, rent_id, vehicle_type, usage_days, total_cost, booking_status, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.session.userId, rentId, bikeType, days, totalPrice, 'Confirmed', 'Pending'],
      function (insertErr) {
        if (insertErr) {
          console.error('Insert booking error:', insertErr);
          return res.status(500).json({ success: false, message: 'Failed to record booking.' });
        }

        return res.json({
          success: true,
          message: 'Ride booked successfully!',
          booking: {
            id: this.lastID,
            trip_id: this.lastID,
            rent_id: rentId,
            bike_type: bikeType,
            rental_days: days,
            total_price: totalPrice,
            status: 'Confirmed',
            payment_status: 'Pending'
          }
        });
      }
    );
  });
});

// Bookings - Generate UPI QR Code & Simulate Email/SMS Notifications
app.post('/api/bookings/:id/pay', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
  }

  const tripId = req.params.id;

  db.get(
    `SELECT b.*, u.email, u.mobile_no, u.user_name FROM tbl_booking_details b JOIN tbl_users u ON b.user_id = u.user_id WHERE b.trip_id = ? AND b.user_id = ?`,
    [tripId, req.session.userId],
    async (err, booking) => {
      if (err) {
        console.error('Fetch booking for payment error:', err);
        return res.status(500).json({ success: false, message: 'Database error.' });
      }

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking record not found.' });
      }

      const upiString = `upi://pay?pa=ogbikerentals@upi&pn=OGBikeRentals&am=${booking.total_cost}&cu=INR&tn=Trip_${booking.trip_id}`;

      try {
        const qrCodeUrl = await QRCode.toDataURL(upiString, { width: 300, margin: 2 });
        const userEmail = booking.email;
        const userMobile = booking.mobile_no || '+91 9840494166';
        const paymentLink = `http://localhost:${PORT}/dashboard?pay_id=${booking.trip_id}`;

        console.log(`\n================ SIMULATED NOTIFICATION DISPATCH ================`);
        console.log(`[EMAIL DISPATCH] To: ${userEmail}`);
        console.log(`  Subject: Payment Request - OG Bike Rentals Trip #${booking.trip_id}`);
        console.log(`  Message: Dear ${booking.user_name}, please complete your payment of ₹${booking.total_cost} for your ${booking.vehicle_type} rental via UPI: ${upiString} or Link: ${paymentLink}`);
        console.log(`[SMS DISPATCH] To: ${userMobile}`);
        console.log(`  Message: OG Bikes: Pay ₹${booking.total_cost} for Trip #${booking.trip_id} using UPI QR or link: ${paymentLink}`);
        console.log(`=================================================================\n`);

        return res.json({
          success: true,
          qrCodeUrl,
          upiString,
          paymentLink,
          emailSentTo: userEmail,
          smsSentTo: userMobile,
          booking: {
            id: booking.trip_id,
            trip_id: booking.trip_id,
            total_price: booking.total_cost,
            bike_type: booking.vehicle_type,
            rental_days: booking.usage_days,
            status: booking.booking_status,
            payment_status: booking.payment_status
          }
        });
      } catch (qrErr) {
        console.error('QR generation error:', qrErr);
        return res.status(500).json({ success: false, message: 'Failed to generate payment QR code.' });
      }
    }
  );
});

// Bookings - Confirm Payment Completion
app.post('/api/bookings/:id/confirm-payment', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
  }

  const tripId = req.params.id;

  db.run(
    "UPDATE tbl_booking_details SET payment_status = 'Paid' WHERE trip_id = ? AND user_id = ?",
    [tripId, req.session.userId],
    function (err) {
      if (err) {
        console.error('Confirm payment error:', err);
        return res.status(500).json({ success: false, message: 'Failed to update payment status.' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ success: false, message: 'Booking record not found.' });
      }

      return res.json({
        success: true,
        message: 'Payment confirmed successfully!'
      });
    }
  );
});

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🏍 OG Bike Rentals Application Server Live!`);
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
