const express = require('express');
const router = express.Router();
const inquiryController = require('../controllers/inquiryController');
const { verifyToken } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

// Configure Multer for Inquiry Documents
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'inquiry-doc-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// License documents for License Renewal requests — kept in memory and pushed to
// Supabase Storage by the controller (images or PDF, max 5MB).
const licenseUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Only image or PDF files are allowed.'));
    }
});

/**
 * 2. Inquiry APIs
 */
// GET /api/inquiries
router.get('/inquiries', verifyToken, inquiryController.getInquiries);

// GET /api/inquiries/form-options — must stay above /inquiries/:id
router.get('/inquiries/form-options', verifyToken, inquiryController.getInquiryFormOptions);

// GET /api/inquiries/product-lookup?code=... — customer CAT# / Product# lookup (above /inquiries/:id)
router.get('/inquiries/product-lookup', verifyToken, inquiryController.lookupProduct);

// POST /api/inquiries/license-document
router.post('/inquiries/license-document', verifyToken, (req, res) => {
    licenseUpload.single('file')(req, res, (err) => {
        if (err) {
            const message = err.code === 'LIMIT_FILE_SIZE' ? 'File must be 5MB or smaller.' : err.message;
            return res.status(400).json({ success: false, data: null, error: message });
        }
        inquiryController.uploadLicenseDocument(req, res);
    });
});

// POST /api/inquiries/customer-document — optional PDF a customer attaches to a Validation request
const customerDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Only PDF files are allowed.'));
    }
});
router.post('/inquiries/customer-document', verifyToken, (req, res) => {
    customerDocumentUpload.single('file')(req, res, (err) => {
        if (err) {
            const message = err.code === 'LIMIT_FILE_SIZE' ? 'File must be 5MB or smaller.' : err.message;
            return res.status(400).json({ success: false, data: null, error: message });
        }
        inquiryController.uploadCustomerDocument(req, res);
    });
});

// POST /api/inquiries
router.post('/inquiries', verifyToken, inquiryController.createInquiry);

// GET /api/inquiries/:id
router.get('/inquiries/:id', verifyToken, inquiryController.getInquiryById);

// GET /api/inquiries/:id/events — timeline (inquiry_events), oldest first
router.get('/inquiries/:id/events', verifyToken, inquiryController.getInquiryEvents);

// PATCH /api/inquiries/:id
router.patch('/inquiries/:id', verifyToken, inquiryController.updateInquiry);

/**
 * 3. Inquiry Items APIs
 */
// PATCH /api/inquiry-items/:id
router.patch('/inquiry-items/:id', verifyToken, inquiryController.updateInquiryItem);

// POST /api/inquiries/:id/items
router.post('/inquiries/:id/items', verifyToken, inquiryController.addInquiryItems);

/**
 * 4. Item Services APIs
 */
// POST /api/inquiry-items/:id/services
router.post('/inquiry-items/:id/services', verifyToken, inquiryController.addItemService);

/**
 * 5. Documents API
 */
// POST /api/inquiry-documents
router.post('/inquiry-documents', verifyToken, upload.array('documents', 5), inquiryController.uploadDocument);

module.exports = router;
