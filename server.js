require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
// const db = require('./db'); // Replaced by Supabase

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static('uploads'));

// Basic health check
app.get('/', (req, res) => {
    res.json({ message: 'Fire Protection Service API is running' });
});

const authRoutes = require('./routes/auth');
const agentsRoutes = require('./routes/agents');
const customersRoutes = require('./routes/customers');
const servicesRoutes = require('./routes/services');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');
const partnersRoutes = require('./routes/partners');
const inquiryRoutes = require('./routes/inquiryRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const seniorAgentsRoutes = require('./routes/seniorAgents');

app.use('/api/auth', authRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/partners', partnersRoutes);
app.use('/api/partner', partnersRoutes); // Added singular mount
app.use('/api', maintenanceRoutes); // PATCH /inquiries/:id/accept, site-assessments, inspections
app.use('/api', inquiryRoutes); // Mounts /api/inquiries, /api/inquiry-items, etc.
app.use('/api', chatRoutes); // Mounts /api/queries and /api/customers/:id/header
app.use('/api/senior-agents', seniorAgentsRoutes);


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
