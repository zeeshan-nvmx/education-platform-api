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

// Verify SMTP connection
const verifyConnection = async () => {
  try {
    await transporter.verify()
    console.log('SMTP connection verified successfully')
    return true
  } catch (error) {
    console.error('SMTP connection verification failed:', error)
    return false
  }
}

// Utility function to send email
const sendEmail = async ({ to, subject, text, html }) => {
  try {
    if (!to) {
      throw new Error('Recipient email is required')
    }

    const mailOptions = {
      from: `${process.env.EMAIL_FROM || process.env.SMTP_USER} <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    }

    const info = await transporter.sendMail(mailOptions)
    console.log('Email sent:', info.messageId)
    return true
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

  return await sendEmail({ to: email, subject, text, html })
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

  return await sendEmail({ to: email, subject, text, html })
}

// Send quiz graded notification email
const sendQuizGradedEmail = async (userEmail, userName, quizTitle, lessonTitle, score, percentage, passed) => {
  try {
    const subject = `Your quiz "${quizTitle}" has been graded`
    const text = `Hello ${userName}, your quiz submission for "${quizTitle}" in the lesson "${lessonTitle}" has been graded. Score: ${score}, Percentage: ${percentage.toFixed(
      1
    )}%. ${passed ? 'Congratulations! You passed the quiz.' : 'You did not pass the quiz.'}`

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
        <h2 style="color: #333;">Hello ${userName},</h2>
        
        <p>Your quiz submission for <strong>${quizTitle}</strong> in the lesson <strong>${lessonTitle}</strong> has been graded.</p>
        
        <div style="background-color: ${passed ? '#e8f5e9' : '#ffebee'}; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: ${passed ? '#2e7d32' : '#c62828'};">
            ${passed ? '🎉 You passed!' : '📝 Not passed yet'}
          </h3>
          <p><strong>Score:</strong> ${score}</p>
          <p><strong>Percentage:</strong> ${percentage.toFixed(1)}%</p>
        </div>
        
        <p>You can view detailed feedback and results by logging into your account and visiting the lesson page.</p>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 0.9em;">This is an automated message, please do not reply to this email.</p>
        </div>
      </div>
    `

    return await sendEmail({ to: userEmail, subject, text, html })
  } catch (error) {
    console.error('Error sending quiz graded email:', error)
    return false
  }
}

module.exports = {
  sendEmail,
  sendVerificationOtp,
  sendPasswordResetOtp,
  sendQuizGradedEmail,
  verifyConnection,
}

// const nodemailer = require('nodemailer')

// // Create transporter
// const transporter = nodemailer.createTransport({
//   host: process.env.SMTP_HOST,
//   port: process.env.SMTP_PORT,
//   // secure: process.env.SMTP_SECURE === 'true',
//   auth: {
//     user: process.env.SMTP_USER,
//     pass: process.env.SMTP_PASS,
//   },
// })

// // Utility function to send email
// const sendEmail = async ({ to, subject, text, html }) => {
//   try {
//     if (!to) {
//       throw new Error('Recipient email is required')
//     }

//     const mailOptions = {
//       from: `${process.env.EMAIL_FROM} <${process.env.EMAIL_FROM}>`,
//       to,
//       subject,
//       text,
//       html,
//     }

//     await transporter.sendMail(mailOptions)
//   } catch (error) {
//     console.error('Email error:', error)
//     throw new Error('Error sending email')
//   }
// }

// // Send verification OTP
// const sendVerificationOtp = async (email, otp) => {
//   const subject = 'Verify your email'
//   const text = `Your verification code is: ${otp}`
//   const html = `
//     <h1>Email Verification</h1>
//     <p>Use this code to verify your email address:</p>
//     <h2 style="color: #4F46E5; letter-spacing: 2px; font-size: 24px; margin: 20px 0;">${otp}</h2>
//     <p>This code will expire in 10 minutes.</p>
//   `

//   await sendEmail({ to: email, subject, text, html })
// }

// // Send password reset OTP
// const sendPasswordResetOtp = async (email, otp) => {
//   const subject = 'Reset your password'
//   const text = `Your password reset code is: ${otp}`
//   const html = `
//     <h1>Password Reset</h1>
//     <p>Use this code to reset your password:</p>
//     <h2 style="color: #4F46E5; letter-spacing: 2px; font-size: 24px; margin: 20px 0;">${otp}</h2>
//     <p>This code will expire in 10 minutes.</p>
//     <p>If you didn't request this, please ignore this email.</p>
//   `

//   await sendEmail({ to: email, subject, text, html })
// }

// module.exports = {
//   sendEmail,
//   sendVerificationOtp,
//   sendPasswordResetOtp,
// }
