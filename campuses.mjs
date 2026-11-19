export const DEFAULT_CAMPUS_ID = 'ncnu';

export const CAMPUSES = [
  {
    id: 'ncnu', shortName: '暨大', name: '國立暨南國際大學', area: '埔里校園',
    center: [23.95165, 120.92715], zoom: 16,
    googleDomain: 'mail1.ncnu.edu.tw', hostedDomains: ['mail1.ncnu.edu.tw', 'ncnu.edu.tw'],
    regions: [
      { name: '圖書館周邊', label: '圖書館', position: [23.9517, 120.9262], placeType: '圖書館' },
      { name: '人文學院周邊', label: '人文學院', position: [23.9501, 120.9292], placeType: '校園空間' },
      { name: '科技學院周邊', label: '科技學院', position: [23.9545, 120.9277] },
      { name: '管理學院周邊', label: '管理學院', position: [23.9521, 120.9278], placeType: '校園空間' },
      { name: '學生宿舍周邊', label: '學生宿舍', position: [23.9489, 120.9252] },
    ],
  },
  {
    id: 'ntu', shortName: '台大', name: '國立臺灣大學', area: '校總區',
    center: [25.018, 121.5395], zoom: 15,
    googleDomain: 'g.ntu.edu.tw', hostedDomains: ['g.ntu.edu.tw', 'ntu.edu.tw'],
    regions: [
      { name: '總圖書館周邊', label: '總圖書館', position: [25.01725, 121.54042], placeType: '圖書館' },
      { name: '綜合體育館周邊', label: '綜合體育館', position: [25.02161, 121.53518] },
      { name: '法學院圖書館周邊', label: '法學院圖書館', position: [25.01993, 121.54479], placeType: '圖書館' },
      { name: '公館站周邊', label: '公館站', position: [25.01492, 121.53426] },
    ],
  },
  {
    id: 'ncku', shortName: '成大', name: '國立成功大學', area: '光復與成功校區',
    center: [22.9987, 120.2184], zoom: 16,
    googleDomain: 'gs.ncku.edu.tw', hostedDomains: ['gs.ncku.edu.tw', 'ncku.edu.tw'],
    regions: [
      { name: '總圖書館周邊', label: '總圖書館', position: [22.99992, 120.21990], placeType: '圖書館' },
      { name: '榕園周邊', label: '榕園', position: [23.00030, 120.21620] },
      { name: '成大博物館周邊', label: '成大博物館', position: [22.99673, 120.21963] },
      { name: '學生活動中心周邊', label: '學生活動中心', position: [22.99785, 120.21630], placeType: '校園空間' },
      { name: '管理學院周邊', label: '管理學院', position: [22.99778, 120.21750], placeType: '校園空間' },
    ],
  },
  {
    id: 'ncue', shortName: '彰師大', name: '國立彰化師範大學', area: '進德校區',
    center: [24.08119, 120.55875], zoom: 16,
    googleDomain: 'gm.ncue.edu.tw', hostedDomains: ['gm.ncue.edu.tw', 'ncue.edu.tw'],
    regions: [
      { name: '圖資大樓周邊', label: '圖資大樓', position: [24.08084, 120.55763], placeType: '圖書館' },
      { name: '教學大樓周邊', label: '教學大樓', position: [24.08125, 120.55686], placeType: '校園空間' },
      { name: '學生活動中心周邊', label: '學生活動中心', position: [24.08115, 120.55925], placeType: '校園空間' },
      { name: '白沙大樓周邊', label: '白沙大樓', position: [24.08150, 120.55836] },
      { name: '小白沙湖周邊', label: '小白沙湖', position: [24.08206, 120.55822] },
    ],
  },
  {
    id: 'nuk', shortName: '高大', name: '國立高雄大學', area: '楠梓校園',
    center: [22.73348, 120.28267], zoom: 15,
    googleDomain: 'mail.nuk.edu.tw', hostedDomains: ['mail.nuk.edu.tw', 'nuk.edu.tw'],
    regions: [
      { name: '高大圖書館周邊', label: '高大圖書館', position: [22.73432, 120.28524], placeType: '圖書館' },
      { name: '行政大樓周邊', label: '行政大樓', position: [22.73431, 120.28401] },
      { name: '理學院周邊', label: '理學院', position: [22.73554, 120.28584], placeType: '校園空間' },
      { name: '學生活動中心周邊', label: '學生活動中心', position: [22.73235, 120.28116], placeType: '校園空間' },
      { name: '校門周邊', label: '校門', position: [22.73267, 120.28456] },
    ],
  },
];

const campusById = new Map(CAMPUSES.map(campus => [campus.id, campus]));

export function getCampus(id) {
  return campusById.get(id);
}

export function campusRegionNames(id) {
  return (getCampus(id) ?? getCampus(DEFAULT_CAMPUS_ID)).regions.map(region => region.name);
}
