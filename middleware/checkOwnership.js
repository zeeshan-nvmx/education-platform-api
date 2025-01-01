const { AppError } = require('../utils/errors')
const { Course, Module, Lesson } = require('../models')

exports.checkCourseOwnership = async (req, res, next) => {
  const course = await Course.findById(req.params.courseId)
  if (!course) {
    return next(new AppError('Course not found', 404))
  }

  if (req.user.role === 'admin' || course.creator.toString() === req.user._id.toString()) {
    req.course = course
    return next()
  }

  next(new AppError('Not authorized to modify this course', 403))
}

exports.checkModuleOwnership = async (req, res, next) => {
  const module = await Module.findById(req.params.moduleId).populate('course')

  if (!module) {
    return next(new AppError('Module not found', 404))
  }

  if (req.user.role === 'admin' || module.course.creator.toString() === req.user._id.toString()) {
    req.module = module
    return next()
  }

  next(new AppError('Not authorized to modify this module', 403))
}
