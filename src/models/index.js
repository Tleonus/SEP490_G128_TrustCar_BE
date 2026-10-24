/**
 * Registers the complete TrustCar model set.
 *
 * The existing API models remain the compatibility layer used by current
 * controllers/services. The ERD-only models are registered alongside them so
 * new modules can import them without keeping a second database package.
 */

import ActivityLog from './ActivityLog.js';
import Appointment from './Appointment.js';
import Car from './Car.js';
import CarModel from './CarModel.js';
import Customer from './Customer.js';
import InspectionRecord from './InspectionRecord.js';
import Lead from './Lead.js';
import PriceHistory from './PriceHistory.js';
import Role from './Role.js';
import User from './User.js';

import Brand from './brand.model.js';
import ChatConversation from './chat-conversation.model.js';
import ChatMessage from './chat-message.model.js';
import ContentItem from './content-item.model.js';
import Feedback from './feedback.model.js';
import InteractionEvent from './interaction-event.model.js';
import LeadActivity from './lead-activity.model.js';
import LeadTask from './lead-task.model.js';
import LeadVehicleInterest from './lead-vehicle-interest.model.js';
import Permission from './permission.model.js';
import RecommendationBatch from './recommendation-batch.model.js';
import SaleRecord from './sale-record.model.js';
import ShowroomService from './showroom-service.model.js';
import SystemSetting from './system-setting.model.js';
import ValuationRule from './valuation-rule.model.js';
import VisitorSession from './visitor-session.model.js';

export {
  ActivityLog,
  Appointment,
  Brand,
  Car,
  CarModel,
  ChatConversation,
  ChatMessage,
  ContentItem,
  Customer,
  Feedback,
  InspectionRecord,
  InteractionEvent,
  Lead,
  LeadActivity,
  LeadTask,
  LeadVehicleInterest,
  Permission,
  PriceHistory,
  RecommendationBatch,
  Role,
  SaleRecord,
  ShowroomService,
  SystemSetting,
  User,
  ValuationRule,
  VisitorSession,
};
