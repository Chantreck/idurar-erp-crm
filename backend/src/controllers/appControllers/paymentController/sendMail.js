const mongoose = require("mongoose");

const {sendInvoiceEmail: sendEmailByResend} = require('../../../utils/emailService');
const {SendPaymentReceipt} = require("@/emailTemplate/SendEmailTemplate");
const Model = mongoose.model('Payment');

const mail = async (req, res) => {
  const payment = await Model.findOne({
    _id: req.body.id,
    removed: false,
  })
      .populate('createdBy', 'name')
      .exec();
  const client = payment.client;

  try {
    await sendEmailByResend(client.email, `Payment ${payment.number} Reciept `, SendPaymentReceipt({
      title: `Thank you for your ${payment.amount}$`, name: client.name, time: payment.date,
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
