const nodemailer = require('nodemailer')

// Create transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  // secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
})

// Utility function to send email
const sendEmail = async ({ to, subject, text, html }) => {
  try {
    if (!to) {
      throw new Error('Recipient email is required')
    }

    const mailOptions = {
      from: `${process.env.EMAIL_FROM} <${process.env.EMAIL_FROM}>`,
      to,
      subject,
      text,
      html,
    }

    await transporter.sendMail(mailOptions)
  } catch (error) {
    console.error('Email error:', error)
    throw new Error('Error sending email')
  }
}

// Send verification OTP
const sendVerificationOtp = async (email, otp) => {
  const subject = 'Verify your email'
  const text = `Your verification code is: ${otp}`
  const html = `
    <h1>Email Verification</h1>
    <p>Use this code to verify your email address:</p>
    <h2 style="color: #4F46E5; letter-spacing: 2px; font-size: 24px; margin: 20px 0;">${otp}</h2>
    <p>This code will expire in 10 minutes.</p>
  `

  await sendEmail({ to: email, subject, text, html })
}

// Send password reset OTP
const sendPasswordResetOtp = async (email, otp) => {
  const subject = 'Reset your password'
  const text = `Your password reset code is: ${otp}`
  const html = `
    <h1>Password Reset</h1>
    <p>Use this code to reset your password:</p>
    <h2 style="color: #4F46E5; letter-spacing: 2px; font-size: 24px; margin: 20px 0;">${otp}</h2>
    <p>This code will expire in 10 minutes.</p>
    <p>If you didn't request this, please ignore this email.</p>
  `

  await sendEmail({ to: email, subject, text, html })
}

module.exports = {
  sendEmail,
  sendVerificationOtp,
  sendPasswordResetOtp,
}

// const nodemailer = require('nodemailer')

// const transporter = nodemailer.createTransport({
//   host: process.env.SMTP_HOST,
//   port: process.env.SMTP_PORT,
//   // secure: true,
//   auth: {
//     user: process.env.SMTP_USER,
//     pass: process.env.SMTP_PASS,
//   },
// })

// const sendEmail = async (to, subject, html) => {
//   await transporter.sendMail({
//     from: process.env.EMAIL_FROM,
//     to,
//     subject,
//     html,
//   })
// }

// const sendVerificationOtp = async (email, otp) => {
//   await sendEmail({
//     from: process.env.EMAIL_FROM,
//     to: email,
//     subject: 'Verify your email',
//     text: `Your verification code is: ${otp}`,
//   })
// }

// const sendPasswordResetOtp = async (email, otp) => {
//   await sendEmail({
//     from: process.env.EMAIL_FROM,
//     to: email,
//     subject: 'Reset your password',
//     text: `Your password reset code is: ${otp}`,
//   })
// }

// module.exports = { sendEmail, sendVerificationOtp, sendPasswordResetOtp }
