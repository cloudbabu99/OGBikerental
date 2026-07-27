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

// Setup DB Tables & Migrations
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      mobile TEXT,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`ALTER TABLE users ADD COLUMN mobile TEXT`, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bike_type TEXT NOT NULL,
      rental_days INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      status TEXT DEFAULT 'Confirmed',
      payment_status TEXT DEFAULT 'Pending',
      booking_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  db.run(`ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'Pending'`, () => {});
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
  const { name, email, mobile, password } = req.body;

  if (!name || !email || !password || !mobile) {
    return res.status(400).json({ success: false, message: 'All fields including mobile number are required.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const cleanMobile = mobile.trim();

  // Check if user exists
  db.get('SELECT id FROM users WHERE email = ?', [normalizedEmail], (err, row) => {
    if (err) {
      console.error('Signup error:', err);
      return res.status(500).json({ success: false, message: 'Internal database error.' });
    }

    if (row) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    db.run(
      'INSERT INTO users (name, email, mobile, password) VALUES (?, ?, ?, ?)',
      [name.trim(), normalizedEmail, cleanMobile, hashedPassword],
      function (insertErr) {
        if (insertErr) {
          console.error('Insert user error:', insertErr);
          return res.status(500).json({ success: false, message: 'Failed to register account.' });
        }

        const newUser = { id: this.lastID, name: name.trim(), email: normalizedEmail, mobile: cleanMobile };
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

  db.get('SELECT * FROM users WHERE email = ?', [normalizedEmail], (err, user) => {
    if (err) {
      console.error('Login error:', err);
      return res.status(500).json({ success: false, message: 'Internal database error.' });
    }

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    const sessionUser = { id: user.id, name: user.name, email: user.email, mobile: user.mobile || '+91 9840494166' };
    req.session.userId = user.id;
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
    'SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC',
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

  const rates = {
    'Scooter': 499,
    'Sports Bike': 1499,
    'Adventure Bike': 2499
  };

  const rate = rates[bikeType];
  if (!rate) {
    return res.status(400).json({ success: false, message: 'Invalid vehicle type selected.' });
  }

  const totalPrice = rate * days;

  db.run(
    'INSERT INTO bookings (user_id, bike_type, rental_days, total_price, status, payment_status) VALUES (?, ?, ?, ?, ?, ?)',
    [req.session.userId, bikeType, days, totalPrice, 'Confirmed', 'Pending'],
    function (err) {
      if (err) {
        console.error('Insert booking error:', err);
        return res.status(500).json({ success: false, message: 'Failed to record booking.' });
      }

      return res.json({
        success: true,
        message: 'Ride booked successfully!',
        booking: {
          id: this.lastID,
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

// Bookings - Generate UPI QR Code & Simulate Email/SMS Notifications
app.post('/api/bookings/:id/pay', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.' });
  }

  const bookingId = req.params.id;

  db.get(
    'SELECT b.*, u.email, u.mobile, u.name FROM bookings b JOIN users u ON b.user_id = u.id WHERE b.id = ? AND b.user_id = ?',
    [bookingId, req.session.userId],
    async (err, booking) => {
      if (err) {
        console.error('Fetch booking for payment error:', err);
        return res.status(500).json({ success: false, message: 'Database error.' });
      }

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking record not found.' });
      }

      const upiString = `upi://pay?pa=ogbikerentals@upi&pn=OGBikeRentals&am=${booking.total_price}&cu=INR&tn=Booking_${booking.id}`;

      try {
        const qrCodeUrl = await QRCode.toDataURL(upiString, { width: 300, margin: 2 });
        const userEmail = booking.email;
        const userMobile = booking.mobile || '+91 9840494166';
        const paymentLink = `http://localhost:${PORT}/dashboard?pay_id=${booking.id}`;

        // Console Log Simulated Email and SMS dispatch
        console.log(`\n================ SIMULATED NOTIFICATION DISPATCH ================`);
        console.log(`[EMAIL DISPATCH] To: ${userEmail}`);
        console.log(`  Subject: Payment Request - OG Bike Rentals Booking #${booking.id}`);
        console.log(`  Message: Dear ${booking.name}, please complete your payment of ₹${booking.total_price} for your ${booking.bike_type} rental via UPI: ${upiString} or Link: ${paymentLink}`);
        console.log(`[SMS DISPATCH] To: ${userMobile}`);
        console.log(`  Message: OG Bikes: Pay ₹${booking.total_price} for Booking #${booking.id} using UPI QR or link: ${paymentLink}`);
        console.log(`=================================================================\n`);

        return res.json({
          success: true,
          qrCodeUrl,
          upiString,
          paymentLink,
          emailSentTo: userEmail,
          smsSentTo: userMobile,
          booking
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

  const bookingId = req.params.id;

  db.run(
    "UPDATE bookings SET payment_status = 'Paid' WHERE id = ? AND user_id = ?",
    [bookingId, req.session.userId],
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
