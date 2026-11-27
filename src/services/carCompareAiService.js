/**
 * @file carCompareAiService.js
 * @description On-demand AI quick analysis and situational recommendation for vehicle comparison.
 *
 * Business rules:
 * 1. Never fabricates arbitrary scores (/100) or compatibility percentages (% phù hợp).
 * 2. Only runs when the user explicitly requests AI advice.
 * 3. Strictly grounded on the allow-listed comparison DTOs returned by `compareCars(ids)`.
 * 4. Explicitly notes missing ("Chưa cập nhật") specifications instead of guessing them.
 * 5. Always includes a clear disclaimer warning that AI analysis is for reference only and may contain mistakes.
 * 6. Gracefully falls back to deterministic fact-based Vietnamese analysis when LLM is unconfigured or unavailable.
 */

import { compareCars } from './carCompareService.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 9000;

export const AI_DISCLAIMER_TEXT =
  'Lưu ý: Nội dung phân tích và gợi ý trên được tạo tự động bởi AI chỉ nhằm mục đích tham khảo nhanh dựa trên thông số niêm yết. AI có thể sai sót hoặc chưa phản ánh hết tình trạng thực tế — quý khách vui lòng đối chiếu bảng thông số kỹ thuật chi tiết và đặt lịch xem xe/lái thử trực tiếp tại Showroom TrustCar.';

const BODY_TYPE_LABEL = {
  SEDAN: 'Sedan',
  SUV: 'SUV / Gầm cao',
  HATCHBACK: 'Hatchback',
  PICKUP: 'Bán tải',
  VAN: 'Van',
  COUPE: 'Coupe',
  CONVERTIBLE: 'Mui trần',
  WAGON: 'Wagon',
  MPV: 'MPV đa dụng',
};

const FUEL_TYPE_LABEL = {
  GASOLINE: 'Xăng',
  PETROL: 'Xăng',
  DIESEL: 'Dầu Diesel',
  HYBRID: 'Hybrid',
  ELECTRIC: 'Điện',
  LPG: 'LPG',
};

const TRANSMISSION_LABEL = {
  MANUAL: 'Số sàn',
  AUTOMATIC: 'Số tự động',
  CVT: 'Số tự động vô cấp (CVT)',
  DCT: 'Ly hợp kép (DCT)',
};

const DRIVE_TYPE_LABEL = {
  FWD: 'Cầu trước (FWD)',
  RWD: 'Cầu sau (RWD)',
  AWD: 'Toàn thời gian (AWD)',
  '4WD': '2 cầu (4WD)',
};

const CONDITION_GRADE_LABEL = {
  A: 'Hạng A (Rất tốt)',
  B: 'Hạng B (Tốt)',
  C: 'Hạng C (Khá)',
  D: 'Hạng D (Trung bình)',
};

const PREFERENCE_META = {
  overall: {
    key: 'overall',
    label: 'Tổng quan cân bằng',
    focus: 'cân bằng giữa giá bán, năm sản xuất, số km đã đi (Odo), khả năng vận hành và tiện nghi',
  },
  economy: {
    key: 'economy',
    label: 'Kinh tế & Tiết kiệm',
    focus: 'tối ưu ngân sách mua xe, mức tiết kiệm so với giá thị trường và mức tiêu hao nhiên liệu',
  },
  family: {
    key: 'family',
    label: 'Gia đình & Tiện nghi',
    focus: 'không gian chỗ ngồi, kiểu dáng thực dụng, đánh giá an toàn và danh sách tiện nghi phục vụ gia đình',
  },
  performance: {
    key: 'performance',
    label: 'Vận hành & Cảm giác lái',
    focus: 'công suất động cơ (HP), mô-men xoắn (Nm), dung tích máy, hộp số và hệ dẫn động',
  },
  likenew: {
    key: 'likenew',
    label: 'Xe lướt & Độ mới',
    focus: 'năm sản xuất đời cao, số Odo (km đã đi) thấp và phân hạng tình trạng xe',
  },
};

const GRADE_RANK = { A: 4, B: 3, C: 2, D: 1 };

const isPositiveNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export const formatVnd = (price) => {
  if (!isPositiveNum(price)) return 'Chưa cập nhật';
  if (price >= 1_000_000_000) {
    const billions = Math.floor(price / 1_000_000_000);
    const millions = Math.round((price % 1_000_000_000) / 1_000_000);
    return millions > 0 ? `${billions} tỷ ${millions} triệu đồng` : `${billions} tỷ đồng`;
  }
  return `${Math.round(price / 1_000_000).toLocaleString('vi-VN')} triệu đồng`;
};

export const formatKm = (km) =>
  isNonNegNum(km) ? `${Math.round(km).toLocaleString('vi-VN')} km` : 'Chưa cập nhật';

export const buildCarTitle = (car) =>
  [car?.make, car?.model, car?.variant, car?.year].filter(Boolean).join(' ') || 'Mẫu xe TrustCar';

/**
 * Builds a structured fact sheet for each vehicle so the LLM only sees real, allow-listed data.
 */
export const buildVehicleFactSheet = (car) => {
  const specs = car.specifications ?? {};
  const features = Array.isArray(specs.features) ? specs.features.filter(Boolean) : [];
  const missingFields = [];

  if (!isPositiveNum(car.price)) missingFields.push('giá bán');
  if (!isPositiveNum(car.year)) missingFields.push('năm sản xuất');
  if (!isNonNegNum(car.mileage)) missingFields.push('số km đã đi (Odo)');
  if (!car.conditionGrade) missingFields.push('phân hạng tình trạng');
  if (!isPositiveNum(specs.horsePower)) missingFields.push('công suất (HP)');
  if (!isPositiveNum(specs.torqueNm)) missingFields.push('mô-men xoắn (Nm)');
  if (!isPositiveNum(specs.fuelConsumption)) missingFields.push('mức tiêu hao nhiên liệu');
  if (!specs.safetyRating) missingFields.push('đánh giá an toàn');
  if (features.length === 0) missingFields.push('danh sách tiện nghi');

  const marketSavings =
    isPositiveNum(car.marketPrice) && isPositiveNum(car.price) && car.marketPrice > car.price
      ? car.marketPrice - car.price
      : 0;

  return {
    carId: String(car._id),
    carTitle: buildCarTitle(car),
    make: car.make || 'Chưa cập nhật',
    model: car.model || 'Chưa cập nhật',
    variant: car.variant || null,
    year: isPositiveNum(car.year) ? car.year : null,
    bodyType: BODY_TYPE_LABEL[car.bodyType] || car.bodyType || 'Chưa cập nhật',
    fuelType: FUEL_TYPE_LABEL[car.fuelType] || car.fuelType || 'Chưa cập nhật',
    transmission: TRANSMISSION_LABEL[car.transmission] || car.transmission || 'Chưa cập nhật',
    driveType: DRIVE_TYPE_LABEL[car.driveType] || car.driveType || 'Chưa cập nhật',
    mileage: isNonNegNum(car.mileage) ? car.mileage : null,
    mileageText: formatKm(car.mileage),
    price: isPositiveNum(car.price) ? car.price : null,
    priceText: formatVnd(car.price),
    marketPriceText: isPositiveNum(car.marketPrice) ? formatVnd(car.marketPrice) : 'Chưa cập nhật',
    marketSavings,
    marketSavingsText: marketSavings > 0 ? formatVnd(marketSavings) : null,
    conditionGrade: car.conditionGrade || null,
    conditionText: CONDITION_GRADE_LABEL[car.conditionGrade] || 'Chưa cập nhật',
    numberOfSeats: isPositiveNum(specs.numberOfSeats) ? specs.numberOfSeats : null,
    engineDisplacementCC: isPositiveNum(specs.engineDisplacementCC) ? specs.engineDisplacementCC : null,
    horsePower: isPositiveNum(specs.horsePower) ? specs.horsePower : null,
    torqueNm: isPositiveNum(specs.torqueNm) ? specs.torqueNm : null,
    fuelConsumption: isPositiveNum(specs.fuelConsumption) ? specs.fuelConsumption : null,
    originCountry: specs.originCountry || 'Chưa cập nhật',
    safetyRating: specs.safetyRating || 'Chưa cập nhật',
    features,
    missingFields,
  };
};

/**
 * Deterministic fact-based comparison builder.
 * Used both as a grounding reference and as an instant fallback when the LLM is unavailable.
 */
export const buildDeterministicAiInsight = (cars, preference = 'overall') => {
  const pref = PREFERENCE_META[preference] || PREFERENCE_META.overall;
  const facts = cars.map(buildVehicleFactSheet);

  const validPrices = facts.map((f) => f.price).filter(isPositiveNum);
  const minPrice = validPrices.length >= 2 ? Math.min(...validPrices) : null;
  const maxPrice = validPrices.length >= 2 ? Math.max(...validPrices) : null;

  const validYears = facts.map((f) => f.year).filter(isPositiveNum);
  const maxYear = validYears.length >= 2 && new Set(validYears).size > 1 ? Math.max(...validYears) : null;

  const validMileages = facts.map((f) => f.mileage).filter(isNonNegNum);
  const minMileage =
    validMileages.length >= 2 && new Set(validMileages).size > 1 ? Math.min(...validMileages) : null;

  const validHps = facts.map((f) => f.horsePower).filter(isPositiveNum);
  const maxHp = validHps.length >= 2 && new Set(validHps).size > 1 ? Math.max(...validHps) : null;

  const validTorques = facts.map((f) => f.torqueNm).filter(isPositiveNum);
  const maxTorque =
    validTorques.length >= 2 && new Set(validTorques).size > 1 ? Math.max(...validTorques) : null;

  const validFuels = facts.map((f) => f.fuelConsumption).filter(isPositiveNum);
  const minFuel =
    validFuels.length >= 2 && new Set(validFuels).size > 1 ? Math.min(...validFuels) : null;

  const validSeats = facts.map((f) => f.numberOfSeats).filter(isPositiveNum);
  const maxSeats =
    validSeats.length >= 2 && new Set(validSeats).size > 1 ? Math.max(...validSeats) : null;

  // Shared vs unique features
  const featureSets = facts.map((f) => new Set(f.features));
  const sharedFeatures =
    featureSets.length >= 2
      ? [...featureSets[0]].filter((item) => featureSets.every((s) => s.has(item)))
      : [];

  const carInsights = facts.map((f) => {
    const strengths = [];
    const considerations = [];
    const uniqueFeatures = f.features.filter((item) => !sharedFeatures.includes(item));

    if (minPrice !== null && maxPrice !== minPrice && f.price === minPrice) {
      strengths.push(
        `Giá niêm yết dễ tiếp cận nhất (${f.priceText}), thấp hơn tới ${formatVnd(maxPrice - minPrice)} so với mẫu xe giá cao nhất trong bàn cân.`
      );
    } else if (minPrice !== null && maxPrice !== minPrice && isPositiveNum(f.price)) {
      considerations.push(
        `Mức giá niêm yết (${f.priceText}) cao hơn ${formatVnd(f.price - minPrice)} so với lựa chọn có giá thấp nhất đang so sánh.`
      );
    }

    if (f.marketSavings > 0) {
      strengths.push(`Giá bán tại TrustCar đang thấp hơn giá tham khảo thị trường khoảng ${f.marketSavingsText}.`);
    }

    if (maxYear !== null && f.year === maxYear) {
      strengths.push(`Đời xe mới hơn (${f.year}), có lợi thế về thời gian sử dụng và thiết kế đời mới.`);
    } else if (maxYear !== null && isPositiveNum(f.year) && f.year < maxYear) {
      considerations.push(`Năm sản xuất (${f.year}) thấp hơn ${maxYear - f.year} năm so với mẫu xe đời mới nhất trong nhóm.`);
    }

    if (minMileage !== null && f.mileage === minMileage) {
      strengths.push(`Số km đã đi thấp nhất nhóm (${f.mileageText}), mức độ hao mòn cơ khí ít hơn.`);
    } else if (minMileage !== null && isNonNegNum(f.mileage) && f.mileage > minMileage) {
      considerations.push(
        `Số Odo đã đi (${f.mileageText}) nhiều hơn ${formatKm(f.mileage - minMileage)} so với xe có Odo thấp nhất.`
      );
    }

    if (f.conditionGrade === 'A') {
      strengths.push('Đạt phân hạng tình trạng Hạng A (Rất tốt) theo hồ sơ ghi nhận tại showroom.');
    }

    if (maxHp !== null && f.horsePower === maxHp) {
      strengths.push(
        `Công suất động cơ nổi trội nhất trong nhóm (${f.horsePower} HP${f.torqueNm ? `, mô-men xoắn ${f.torqueNm} Nm` : ''}).`
      );
    } else if (maxTorque !== null && f.torqueNm === maxTorque) {
      strengths.push(`Lực kéo mô-men xoắn cao nhất nhóm (${f.torqueNm} Nm), hỗ trợ tăng tốc và tải nặng tốt.`);
    }

    if (minFuel !== null && f.fuelConsumption === minFuel) {
      strengths.push(`Mức tiêu hao nhiên liệu công bố tiết kiệm nhất (${f.fuelConsumption} L/100km).`);
    }

    if (maxSeats !== null && f.numberOfSeats === maxSeats) {
      strengths.push(`Không gian bố trí ${f.numberOfSeats} chỗ ngồi, thuận tiện khi chở đông người.`);
    }

    if (uniqueFeatures.length > 0) {
      strengths.push(`Có thêm trang bị riêng so với đối thủ: ${uniqueFeatures.slice(0, 5).join(', ')}.`);
    } else if (f.features.length > 0) {
      strengths.push(`Trang bị tiện nghi có sẵn: ${f.features.slice(0, 4).join(', ')}.`);
    }

    if (f.missingFields.length > 0) {
      considerations.push(
        `Một số thông số đang ở trạng thái "Chưa cập nhật" (${f.missingFields.slice(0, 3).join(', ')}) — cần đối chiếu thực tế tại showroom.`
      );
    }

    if (strengths.length === 0) {
      strengths.push(
        `Cấu hình ${f.bodyType}, hộp số ${f.transmission.toLowerCase()}, nhiên liệu ${f.fuelType.toLowerCase()} với mức giá ${f.priceText}.`
      );
    }

    if (considerations.length === 0) {
      considerations.push('Nên kiểm tra và lái thử trực tiếp để cảm nhận độ cách âm, tầm nhìn và tư thế ngồi thực tế.');
    }

    // Best-for situational advice without arbitrary scores
    const bestForReasons = [];
    if (minPrice !== null && maxPrice !== minPrice && f.price === minPrice) {
      bestForReasons.push('tối ưu chi phí đầu tư ban đầu');
    }
    if (minFuel !== null && f.fuelConsumption === minFuel) {
      bestForReasons.push('tiết kiệm nhiên liệu vận hành hàng ngày');
    }
    if ((maxYear !== null && f.year === maxYear) || (minMileage !== null && f.mileage === minMileage)) {
      bestForReasons.push('ưu tiên xe lướt đời mới, đi ít km');
    }
    if (maxHp !== null && f.horsePower === maxHp) {
      bestForReasons.push('chuộng cảm giác lái khỏe khoắn và công suất máy lớn');
    }
    if (uniqueFeatures.length >= 2 || (maxSeats !== null && f.numberOfSeats === maxSeats)) {
      bestForReasons.push('cần nhiều tiện nghi và không gian phục vụ gia đình');
    }

    const bestFor =
      bestForReasons.length > 0
        ? `Đáng cân nhắc nếu bạn ${bestForReasons.join(', ')}.`
        : `Phù hợp nếu bạn yêu thích thiết kế dòng ${f.make} ${f.model} (${f.bodyType}) trong tầm giá ${f.priceText}.`;

    return {
      carId: f.carId,
      carTitle: f.carTitle,
      strengths,
      considerations,
      bestFor,
    };
  });

  // Summary across cars
  const names = facts.map((f) => f.carTitle).join(' và ');
  const priceSpreadText =
    minPrice !== null && maxPrice !== null
      ? minPrice === maxPrice
        ? `cùng mức giá niêm yết ${formatVnd(minPrice)}`
        : `mức giá dao động từ ${formatVnd(minPrice)} đến ${formatVnd(maxPrice)} (chênh lệch ${formatVnd(maxPrice - minPrice)})`
      : 'mức giá cần đối chiếu thêm';

  const summary = `Đối chiếu nhanh giữa ${names}: các mẫu xe có ${priceSpreadText}. Mỗi xe có sự đánh đổi rõ rệt giữa giá bán, năm sản xuất/số Odo và trang bị đi kèm — không có mẫu xe nào vượt trội tuyệt đối ở mọi tiêu chí.`;

  // Situational recommendation according to user's selected preference
  let recommendation = '';
  const cheapest = minPrice !== null ? facts.find((f) => f.price === minPrice) : null;
  const mostFuelEff = minFuel !== null ? facts.find((f) => f.fuelConsumption === minFuel) : null;
  const newest = maxYear !== null ? facts.find((f) => f.year === maxYear) : null;
  const lowestOdo = minMileage !== null ? facts.find((f) => f.mileage === minMileage) : null;
  const strongest = maxHp !== null ? facts.find((f) => f.horsePower === maxHp) : null;
  const mostEquipped = [...facts].sort((a, b) => b.features.length - a.features.length)[0];

  if (preference === 'economy') {
    const parts = [];
    if (cheapest) parts.push(`${cheapest.carTitle} có lợi thế giá mua ban đầu tốt hơn (${cheapest.priceText})`);
    if (mostFuelEff) parts.push(`${mostFuelEff.carTitle} có mức tiêu hao nhiên liệu công bố thấp hơn (${mostFuelEff.fuelConsumption} L/100km)`);
    recommendation =
      parts.length > 0
        ? `Theo góc nhìn Kinh tế & Tiết kiệm: ${parts.join('; trong khi đó ')}. Bạn nên cân nhắc tổng chi phí lăn bánh và quãng đường di chuyển hàng tháng để chọn xe có lợi nhất.`
        : `Theo góc nhìn Kinh tế & Tiết kiệm: Hãy đối chiếu mức giá niêm yết và kiểm tra thêm thông số tiêu hao nhiên liệu thực tế của từng xe trước khi quyết định.`;
  } else if (preference === 'performance') {
    recommendation = strongest
      ? `Theo góc nhìn Vận hành & Cảm giác lái: ${strongest.carTitle} nổi bật hơn trên thông số giấy tờ với công suất ${strongest.horsePower} HP (${strongest.transmission}, dẫn động ${strongest.driveType}). Tuy nhiên, độ bốc thực tế và độ đầm chắc của khung gầm cần được kiểm chứng qua buổi lái thử trực tiếp.`
      : `Theo góc nhìn Vận hành & Cảm giác lái: Một số thông số công suất/mô-men xoắn chưa được cập nhật đầy đủ giữa các xe; bạn nên đặt lịch lái thử cả ${facts.length} xe để cảm nhận trực tiếp độ trễ chân ga và hộp số.`;
  } else if (preference === 'family') {
    recommendation =
      mostEquipped && mostEquipped.features.length > 0
        ? `Theo góc nhìn Gia đình & Tiện nghi: ${mostEquipped.carTitle} hiện ghi nhận danh sách tiện nghi phong phú hơn (${mostEquipped.features.length} trang bị${mostEquipped.numberOfSeats ? `, ${mostEquipped.numberOfSeats} chỗ ngồi` : ''}). Nếu đi gia đình, bạn nên dẫn người thân cùng ngồi thử hàng ghế sau và kiểm tra khoang hành lý thực tế.`
        : `Theo góc nhìn Gia đình & Tiện nghi: Bạn nên ưu tiên kiểm tra độ rộng hàng ghế thứ 2, dung tích cốp và các tính năng an toàn thực tế trên xe tại showroom.`;
  } else if (preference === 'likenew') {
    const parts = [];
    if (newest) parts.push(`${newest.carTitle} có lợi thế đời xe mới hơn (${newest.year})`);
    if (lowestOdo && (!newest || lowestOdo.carId !== newest.carId)) {
      parts.push(`${lowestOdo.carTitle} có số Odo thấp hơn (${lowestOdo.mileageText})`);
    } else if (lowestOdo) {
      parts.push(`đồng thời sở hữu số Odo thấp nhất (${lowestOdo.mileageText})`);
    }
    recommendation =
      parts.length > 0
        ? `Theo góc nhìn Xe lướt & Độ mới: ${parts.join(', ')}. Bạn nên kết hợp xem biên bản kiểm định thực tế và lịch sử bảo dưỡng để đánh giá chính xác độ mới của nội/ngoại thất.`
        : `Theo góc nhìn Xe lướt & Độ mới: Các mẫu xe có đời và tình trạng khá tương đồng trên thông số; hãy xem trực tiếp chất lượng sơn, nội thất và khoang máy tại showroom.`;
  } else {
    const parts = [];
    if (cheapest) parts.push(`chọn ${cheapest.carTitle} (${cheapest.priceText}) nếu ưu tiên tiết kiệm ngân sách`);
    if (newest && (!cheapest || newest.carId !== cheapest.carId)) {
      parts.push(`chọn ${newest.carTitle} nếu ưu tiên đời xe mới (${newest.year}) và trang bị`);
    } else if (lowestOdo && (!cheapest || lowestOdo.carId !== cheapest.carId)) {
      parts.push(`chọn ${lowestOdo.carTitle} nếu ưu tiên số Odo thấp (${lowestOdo.mileageText})`);
    }
    recommendation =
      parts.length > 0
        ? `Gợi ý tham khảo tổng quan: Bạn có thể ${parts.join('; hoặc ')}. Quyết định cuối cùng nên dựa trên ngân sách thực tế và cảm giác sau khi lái thử.`
        : `Gợi ý tham khảo tổng quan: Các mẫu xe trên bàn cân có thông số khá cân sức; bạn nên dựa vào kiểu dáng yêu thích và trải nghiệm lái thử thực tế tại Showroom TrustCar.`;
  }

  const carsWithMissing = facts.filter((f) => f.missingFields.length > 0);
  const missingDataNote =
    carsWithMissing.length > 0
      ? `Một số trường thông số trên bảng đang ở trạng thái "Chưa cập nhật" (${carsWithMissing
          .map((f) => `${f.carTitle}: ${f.missingFields.slice(0, 3).join(', ')}`)
          .join(' | ')}). AI không tự suy đoán các thông số này.`
      : null;

  return {
    preference: pref.key,
    preferenceLabel: pref.label,
    summary,
    recommendation,
    carInsights,
    missingDataNote,
    disclaimer: AI_DISCLAIMER_TEXT,
    source: 'fallback',
  };
};

const SYSTEM_PROMPT = [
  'Bạn là Chuyên viên Tư vấn Kỹ thuật Ô tô khách quan của Showroom xe đã qua sử dụng TrustCar.',
  'Khách hàng đang bấm nút yêu cầu AI phân tích nhanh và gợi ý tham khảo cho 2-3 mẫu xe trên bàn cân so sánh.',
  '',
  'QUY TẮC NGHIỆP VỤ BẮT BUỘC:',
  '1. CHỈ sử dụng đúng dữ liệu có trong `vehicleFactSheets` được cung cấp. Tuyệt đối KHÔNG tự bịa ra con số, mức giá, năm sản xuất, số Odo, công suất, mức tiêu hao nhiên liệu hay trang bị không có trong dữ liệu.',
  '2. TUYỆT ĐỐI KHÔNG tự chấm điểm (như 85/100, 90 điểm) và KHÔNG đưa ra tỷ lệ phần trăm độ phù hợp (như 92% phù hợp) vì không có căn cứ chấm điểm.',
  '3. Nếu thông số nào của xe có giá trị null hoặc nằm trong `missingFields` ("Chưa cập nhật"), hãy nêu rõ là thông số đó chưa cập nhật để khách hàng kiểm tra thực tế, không tự suy đoán.',
  '4. Phân tích khách quan sự đánh đổi (trade-off): ví dụ xe giá cao hơn thì đổi lại được đời mới hơn, Odo thấp hơn hay nhiều trang bị hơn; xe giá mềm hơn thì tiết kiệm được bao nhiêu tiền.',
  '5. Đưa ra gợi ý theo tình huống ("Nên cân nhắc Xe A nếu bạn ưu tiên...", "Nên cân nhắc Xe B nếu bạn ưu tiên..."), không khẳng định tuyệt đối xe nào thắng toàn diện.',
  '6. Trả về đúng một JSON object hợp lệ (không dùng markdown code fence) theo cấu trúc:',
  '{',
  '  "summary": "2-3 câu nhận xét tổng quan ngắn gọn, súc tích về bức tranh đối chiếu giữa các xe.",',
  '  "recommendation": "2-3 câu gợi ý tham khảo khách quan tập trung vào tiêu chí `preferenceFocus` của khách hàng.",',
  '  "carInsights": [',
  '    {',
  '      "carId": "<giữ nguyên carId>",',
  '      "strengths": ["<ưu thế thực tế 1 dựa trên số liệu>", "<ưu thế thực tế 2>"],',
  '      "considerations": ["<điểm cần cân nhắc / đánh đổi hoặc thông số chưa cập nhật>"],',
  '      "bestFor": "<1 câu ngắn: Phù hợp với người dùng có nhu cầu gì>"',
  '    }',
  '  ]',
  '}',
].join('\n');

const parseJsonReply = (raw) => {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Strips any hallucinated percentage/score patterns like "95% phù hợp" or "92/100" if the model ever slips.
 */
const sanitizeText = (str) =>
  String(str ?? '')
    .replace(/\b\d{1,3}\s*%\s*(?:độ\s*)?phù\s*hợp/gi, 'phù hợp')
    .replace(/\b\d{1,3}\s*\/\s*100(?!\s*km)\s*(?:điểm)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/**
 * Calls the configured OpenAI-compatible / Gemini LLM endpoint, or falls back deterministically.
 *
 * @param {object} params
 * @param {string[]} params.ids - 2 to 3 validated vehicle ObjectIds
 * @param {string} [params.preference='overall'] - User's selected focus lens
 * @param {object} [options] - Optional overrides for testing (fetchImpl, apiKey, baseUrl, model, timeoutMs)
 */
export const generateCompareAiInsight = async (
  { ids, preference = 'overall' },
  options = {}
) => {
  const { cars, unavailableIds } = await compareCars(ids);
  const pref = PREFERENCE_META[preference] || PREFERENCE_META.overall;
  const fallback = buildDeterministicAiInsight(cars, pref.key);

  const apiKey =
    options.apiKey ??
    process.env.CHAT_LLM_API_KEY ??
    process.env.CAPTION_LLM_API_KEY;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!apiKey || typeof fetchImpl !== 'function') {
    return { ...fallback, unavailableIds };
  }

  const baseUrl = (
    options.baseUrl ||
    process.env.CHAT_LLM_BASE_URL ||
    process.env.CAPTION_LLM_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  const model =
    options.model ||
    process.env.CHAT_LLM_MODEL ||
    process.env.CAPTION_LLM_MODEL ||
    (baseUrl.includes('googleapis.com') ? 'gemini-3-flash-preview' : DEFAULT_MODEL);

  const timeoutMs =
    Number(options.timeoutMs ?? process.env.CHAT_LLM_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS;

  const vehicleFactSheets = cars.map(buildVehicleFactSheet);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              preferenceKey: pref.key,
              preferenceLabel: pref.label,
              preferenceFocus: pref.focus,
              vehicleFactSheets,
            }),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ...fallback, unavailableIds };
    }

    const payload = await response.json();
    const rawContent = payload?.choices?.[0]?.message?.content;
    const parsed = parseJsonReply(rawContent);

    if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
      return { ...fallback, unavailableIds };
    }

    const llmInsightsById = new Map(
      (Array.isArray(parsed.carInsights) ? parsed.carInsights : [])
        .filter((item) => item && item.carId)
        .map((item) => [String(item.carId).toLowerCase(), item])
    );

    const mergedCarInsights = fallback.carInsights.map((fbCard) => {
      const candidate = llmInsightsById.get(String(fbCard.carId).toLowerCase());
      if (!candidate) return fbCard;

      const strengths = Array.isArray(candidate.strengths)
        ? candidate.strengths.map(sanitizeText).filter(Boolean).slice(0, 4)
        : [];
      const considerations = Array.isArray(candidate.considerations)
        ? candidate.considerations.map(sanitizeText).filter(Boolean).slice(0, 3)
        : [];
      const bestFor =
        typeof candidate.bestFor === 'string' && candidate.bestFor.trim()
          ? sanitizeText(candidate.bestFor)
          : fbCard.bestFor;

      return {
        carId: fbCard.carId,
        carTitle: fbCard.carTitle,
        strengths: strengths.length > 0 ? strengths : fbCard.strengths,
        considerations: considerations.length > 0 ? considerations : fbCard.considerations,
        bestFor,
      };
    });

    return {
      preference: pref.key,
      preferenceLabel: pref.label,
      summary: sanitizeText(parsed.summary) || fallback.summary,
      recommendation: sanitizeText(parsed.recommendation) || fallback.recommendation,
      carInsights: mergedCarInsights,
      missingDataNote: fallback.missingDataNote,
      disclaimer: AI_DISCLAIMER_TEXT,
      source: 'ai',
      unavailableIds,
    };
  } catch {
    return { ...fallback, unavailableIds };
  } finally {
    clearTimeout(timer);
  }
};

export default {
  generateCompareAiInsight,
  buildDeterministicAiInsight,
  buildVehicleFactSheet,
  AI_DISCLAIMER_TEXT,
};
