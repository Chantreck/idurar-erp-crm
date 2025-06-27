const mongoose = require("mongoose");

const {sendInvoiceEmail: sendEmailByResend} = require('../../../utils/emailService');
const {SendInvoice} = require("@/emailTemplate/SendEmailTemplate");
const Model = mongoose.model('Invoice');

const mail = async (req, res) => {
    const invoice = await Model.findOne({
        _id: req.body.id,
        removed: false,
    })
        .populate('createdBy', 'name')
        .exec();
    const client = invoice.client;

    try {
        await sendEmailByResend(client.email, `Invoice ${invoice.number} from Idurar`, SendInvoice({
            title: `Give us ${invoice.total}$`, name: client.name, time: invoice.created,
        }));

        return res.status(200).json({
            success: true, result: null, message: 'Email sent successfully via Resend',
        });
    } catch (error) {
        console.error('Ошибка при отправке письма:', error.message);
        return res.status(503).json({
            success: false, result: error.message, message: 'Failed to send email via Resend',
        });
    }
};

module.exports = mail;
