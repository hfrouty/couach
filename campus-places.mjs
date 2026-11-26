import { campusCafes } from './campus-cafes.mjs';

// 下列地點經校方、店家或 OpenStreetMap 資料核對。
const campusPlaces = {
  ncnu: [
    // OpenStreetMap node/5241780483
    { id: 'ncnu-library', name: '暨大圖書館', kind: 'library', position: [23.95170, 120.92619] },
    // https://general.ncnu.edu.tw/p/412-1026-2117.php?Lang=zh-tw · OpenStreetMap way/292499321
    { id: 'ncnu-louisa', name: '路易莎咖啡暨南大學門市', kind: 'cafe', position: [23.95008, 120.92575] },
    // https://ddpuli.tw/store-detail.php?id=67 · OpenStreetMap node/7255914390
    { id: 'ncnu-sunshine', name: '享日啡啡', kind: 'cafe', position: [23.94425, 120.93239] },
    // https://linket.app/emolab/ · https://maps.app.goo.gl/wnfcLf1oru9s7Lfy9
    { id: 'ncnu-emolab', name: '桑心實驗室 emoLab', kind: 'cafe', position: [23.94256, 120.92927] },
    // https://travel.nantou.gov.tw/article/南投咖啡廳/ · 官網嵌入地圖，桃米路12-11號
    { id: 'ncnu-zhule', name: '築樂珈琲', kind: 'cafe', position: [23.94894, 120.94001] },
  ],
  ntu: [
    // https://www.lib.ntu.edu.tw/map · OpenStreetMap relation/14045849
    { id: 'ntu-library', name: '臺大總圖書館', kind: 'library', position: [25.01754, 121.54103] },
    // https://faq.lib.ntu.edu.tw/node/276 · OpenStreetMap way/311536360
    { id: 'ntu-koo-library', name: '臺大辜振甫先生紀念圖書館', kind: 'library', position: [25.02042, 121.54230] },
    // https://life.ntu.edu.tw/web/dining/dining_in.jsp?np_id=NP1784193030497 · OpenStreetMap node/7330746360
    { id: 'ntu-louisa', name: '路易莎咖啡台大卓越門市', kind: 'cafe', position: [25.01457, 121.53792] },
    // https://meals.ntu.edu.tw/restaurant/info/id/194 · OpenStreetMap node/4834803706
    { id: 'ntu-starbucks', name: '星巴克長興門市', kind: 'cafe', position: [25.01721, 121.54483] },
    // https://meals.ntu.edu.tw/restaurant/info/id/62 · OpenStreetMap node/4834803856
    { id: 'ntu-movenpick', name: '莫凡彼咖啡館台大門市', kind: 'cafe', position: [25.01307, 121.53655] },
    // https://meals.ntu.edu.tw/restaurant/info/id/330 · OpenStreetMap node/13615461042
    { id: 'ntu-85c-zhoushan', name: '85度C 台大舟山店', kind: 'cafe', position: [25.01529, 121.53682] },
  ],
  ncku: [
    // https://www.lib.ncku.edu.tw/service/access/openhours.php · OpenStreetMap way/251596111
    { id: 'ncku-library', name: '成大總圖書館', kind: 'library', position: [22.99989, 120.21995] },
    // https://www.arch.ncku.edu.tw/cht/module/pageinfo/bid0-585-i9.html · OpenStreetMap node/13140491564
    { id: 'ncku-design-library', name: '成大規劃與設計學院圖書室', kind: 'library', position: [23.00087, 120.21520] },
    // https://b3c003.web3.ncku.edu.tw/p/412-1052-4084.php?Lang=zh-tw · OpenStreetMap way/1469333482
    { id: 'ncku-the-pool', name: '新園春室 The Pool', kind: 'cafe', position: [22.99923, 120.21864] },
    // https://www.starbucks.com.tw/stores/storesearch.jspx?type=mop · OpenStreetMap node/2616887565
    { id: 'ncku-starbucks', name: '星巴克成大長榮門市', kind: 'cafe', position: [22.99630, 120.22229] },
    // https://www.starbucks.com.tw/stores/special/stores_special_Tainan-Cultural-and-Creative-Park.jspx · OpenStreetMap way/204493490
    { id: 'ncku-starbucks-culture', name: '星巴克台南文創門市', kind: 'cafe', position: [22.99897, 120.21299] },
    // https://nckuca.ncku.edu.tw/index.php/location · https://www.google.com/maps?cid=5805977856964986408
    { id: 'ncku-yun-ping', name: '雲平咖啡', kind: 'cafe', position: [22.99882, 120.21703] },
  ],
  ncue: [
    // https://olis.ncue.edu.tw/ · OpenStreetMap way/1171108291
    { id: 'ncue-library', name: '彰師大進德校區圖書館', kind: 'library', position: [24.08084, 120.55763] },
    // https://www.85cafe.com/storein.php?data=2039
    { id: 'ncue-85c', name: '85度C 彰化師大店', kind: 'cafe', position: [24.08601, 120.55856] },
    // https://www.instagram.com/kahju.coffee/ · Google 地圖，力行路97巷39號
    { id: 'ncue-kahju', name: '椛十 Kahju', kind: 'cafe', position: [24.08376, 120.56056] },
    // https://www.instagram.com/taylescafe/ · Google 地圖，實踐路62-1號
    { id: 'ncue-tayles', name: 'TAYLES COFFEE 泰爾斯咖啡', kind: 'cafe', position: [24.08327, 120.55464] },
  ],
  nuk: [
    // https://lic.nuk.edu.tw/ · OpenStreetMap node/2147732211
    { id: 'nuk-library', name: '高雄大學圖書資訊館', kind: 'library', position: [22.73432, 120.28524] },
    // https://www.nuk.edu.tw/p/404-1000-92221.php?Lang=zh-tw · OpenStreetMap way/1145691640
    { id: 'nuk-louisa', name: '路易莎咖啡高雄大學門市', kind: 'cafe', position: [22.73238, 120.28122] },
    // https://www.donutes.com.tw/minid/tw/location · https://maps.app.goo.gl/SN41SEpBUUAPegC29
    { id: 'nuk-minid', name: 'MINI.D COFFEE 藍田館', kind: 'cafe', position: [22.72884, 120.28989] },
    // https://www.starbucks.com.tw/stores/storesearch.jspx?type=mop · OpenStreetMap way/1366777614
    { id: 'nuk-starbucks-lanchang', name: '星巴克楠梓藍昌門市', kind: 'cafe', position: [22.73173, 120.29259] },
    // https://www.starbucks.com.tw/stores/storesearch.jspx?type=mop · OpenStreetMap way/1560185704
    { id: 'nuk-starbucks-dezhong', name: '星巴克楠梓德中門市', kind: 'cafe', position: [22.73035, 120.27225] },
  ],
};

const placesByCampus = new Map(Object.entries(campusPlaces).map(([campusId, places]) => [
  campusId,
  places.concat((campusCafes[campusId] ?? []).map(([id, name, latitude, longitude]) => ({
    id, name, kind: 'cafe', position: [latitude, longitude],
  }))),
]));

export function getCampusPlaces(campusId) {
  return placesByCampus.get(campusId) ?? [];
}
