const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
    },
    role: {
      type: String,
      enum: ['user', 'admin', 'subAdmin', 'moderator'],
      default: 'user',
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    verificationToken: String,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    enrolledCourses: [
      {
        course: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Course',
        },
        enrolledAt: {
          type: Date,
          default: Date.now,
        },
        completedModules: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Module',
          },
        ],
      },
    ],
  },
  { timestamps: true }
)

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

const courseSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    required: true,
  },
  thumbnail: String,
  price: {
    type: Number,
    required: true,
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  featured: {
    type: Boolean,
    default: false,
  },
  rating: {
    type: Number,
    default: 0,
  },
  totalStudents: {
    type: Number,
    default: 0,
  },
}, { timestamps: true });

const moduleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: String,
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  order: {
    type: Number,
    required: true,
  },
  price: {
    type: Number,
    required: true,
  },
}, { timestamps: true });

const lessonSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: String,
  module: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
    required: true,
  },
  order: {
    type: Number,
    required: true,
  },
  videoUrl: String,
  cloudflareVideoId: String,
  duration: Number,
  requireQuizPass: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

const quizSchema = new mongoose.Schema({
  lesson: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lesson',
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['mcq', 'trueFalse', 'written'],
    required: true,
  },
  passingScore: {
    type: Number,
    required: true,
  },
  timeLimit: Number,
  questions: [{
    question: {
      type: String,
      required: true,
    },
    options: [String],
    correctAnswer: String,
    points: {
      type: Number,
      default: 1,
    },
  }],
}, { timestamps: true });

const quizAttemptSchema = new mongoose.Schema({
  quiz: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
    required: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  answers: [{
    question: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    answer: String,
    isCorrect: Boolean,
    points: Number,
  }],
  score: Number,
  passed: Boolean,
  gradedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  submittedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
  },
  module: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
  },
  amount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: 'BDT',
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending',
  },
  transactionId: String,
  sslcommerzSessionKey: String,
  discount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Discount',
  },
  discountedAmount: Number,
}, { timestamps: true });

const discountSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
  },
  type: {
    type: String,
    enum: ['percentage', 'fixed'],
    required: true,
  },
  value: {
    type: Number,
    required: true,
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
  },
  module: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
  },
  startDate: Date,
  endDate: Date,
  maxUses: Number,
  usedCount: {
    type: Number,
    default: 0,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

const progressSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  completedLessons: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lesson',
  }],
  completedQuizzes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
  }],
  lastAccessed: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

const reviewSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  review: String,
}, { timestamps: true });

module.exports = {
  User: mongoose.model('User', userSchema),
  Course: mongoose.model('Course', courseSchema),
  Module: mongoose.model('Module', moduleSchema),
  Lesson: mongoose.model('Lesson', lessonSchema),
  Quiz: mongoose.model('Quiz', quizSchema),
  QuizAttempt: mongoose.model('QuizAttempt', quizAttemptSchema),
  Payment: mongoose.model('Payment', paymentSchema),
  Discount: mongoose.model('Discount', discountSchema),
  Progress: mongoose.model('Progress', progressSchema),
  Review: mongoose.model('Review', reviewSchema),
};