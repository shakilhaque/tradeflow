/**
 * Common Bangladesh thanas (upazilas / sub-districts) grouped by district.
 *
 * Not exhaustive (BD has ~491 thanas across 64 districts) — this is the
 * curated list used by the Subscribe / Trial signup forms' Thana
 * autocomplete. If a tenant types a thana that isn't in the list, the
 * input still accepts it (datalist is a suggestion, not a filter).
 *
 * Source: standard BD administrative geography. Sorted alphabetically
 * within each district for predictable autocomplete behaviour.
 */
export const BD_THANAS_BY_DISTRICT = {
  Dhaka: [
    'Adabor', 'Badda', 'Banani', 'Bangshal', 'Bhashantek', 'Cantonment',
    'Chawkbazar', 'Darus Salam', 'Demra', 'Dhanmondi', 'Gendaria',
    'Gulshan', 'Hatirjheel', 'Hazaribagh', 'Jatrabari', 'Kafrul',
    'Kalabagan', 'Kamrangirchar', 'Khilgaon', 'Khilkhet', 'Kotwali',
    'Lalbagh', 'Mirpur', 'Mohammadpur', 'Motijheel', 'Mugda', 'New Market',
    'Pallabi', 'Paltan', 'Ramna', 'Rampura', 'Rupnagar', 'Sabujbagh',
    'Shah Ali', 'Shahbagh', 'Shyampur', 'Sutrapur', 'Tejgaon',
    'Tejgaon Industrial Area', 'Turag', 'Uttara', 'Uttara East',
    'Uttara West', 'Vatara', 'Wari',
  ],
  Chattogram: [
    'Anwara', 'Banshkhali', 'Boalkhali', 'Chandanaish', 'Chandgaon',
    'Double Mooring', 'Fatikchhari', 'Halishahar', 'Hathazari', 'Karnaphuli',
    'Khulshi', 'Kotwali', 'Lohagara', 'Mirsharai', 'Pahartali',
    'Panchlaish', 'Patenga', 'Patiya', 'Rangunia', 'Raozan', 'Sandwip',
    'Satkania', 'Sitakunda',
  ],
  Gazipur: ['Gazipur Sadar', 'Kaliakair', 'Kaliganj', 'Kapasia', 'Sreepur', 'Tongi'],
  Narayanganj: ['Araihazar', 'Bandar', 'Narayanganj Sadar', 'Rupganj', 'Sonargaon'],
  Mymensingh: [
    'Bhaluka', 'Dhobaura', 'Fulbaria', 'Gaffargaon', 'Gauripur',
    'Haluaghat', 'Ishwarganj', 'Mymensingh Sadar', 'Muktagachha',
    'Nandail', 'Phulpur', 'Trishal',
  ],
  Sylhet: [
    'Balaganj', 'Beanibazar', 'Bishwanath', 'Companiganj', 'Dakshin Surma',
    'Fenchuganj', 'Golapganj', 'Gowainghat', 'Jaintiapur', 'Kanaighat',
    'Osmaninagar', 'Sylhet Sadar', 'Zakiganj',
  ],
  Khulna: [
    'Batiaghata', 'Dacope', 'Daulatpur', 'Dighalia', 'Dumuria',
    'Khalishpur', 'Khulna Sadar', 'Koyra', 'Paikgachha', 'Phultala',
    'Rupsa', 'Sonadanga', 'Terokhada',
  ],
  Rajshahi: [
    'Bagha', 'Bagmara', 'Boalia', 'Charghat', 'Durgapur', 'Godagari',
    'Mohanpur', 'Motihar', 'Paba', 'Puthia', 'Rajpara', 'Shah Makhdum', 'Tanore',
  ],
  Barishal: [
    'Agailjhara', 'Babuganj', 'Bakerganj', 'Banaripara', 'Barishal Kotwali',
    'Gournadi', 'Hizla', 'Mehendiganj', 'Muladi', 'Wazirpur',
  ],
  Rangpur: [
    'Badarganj', 'Gangachara', 'Kaunia', 'Mithapukur', 'Pirgachha',
    'Pirganj', 'Rangpur Kotwali', 'Taraganj',
  ],
  Cumilla: [
    'Barura', 'Brahmanpara', 'Burichang', 'Chandina', 'Chauddagram',
    'Cumilla Adarsha Sadar', 'Cumilla Sadar Dakshin', 'Daudkandi', 'Debidwar',
    'Homna', 'Laksam', 'Lalmai', 'Manoharganj', 'Meghna', 'Monohorgonj',
    'Muradnagar', 'Nangalkot', 'Titas',
  ],
  Khagrachhari: ['Dighinala', 'Khagrachhari Sadar', 'Lakshmichhari', 'Mahalchhari', 'Manikchhari', 'Matiranga', 'Panchhari', 'Ramgarh'],
  Bandarban: ['Alikadam', 'Bandarban Sadar', 'Lama', 'Naikhongchhari', 'Rowangchhari', 'Ruma', 'Thanchi'],
  Rangamati: ['Baghaichhari', 'Barkal', 'Belaichhari', 'Juraichhari', 'Kaptai', 'Kawkhali', 'Langadu', 'Naniarchar', 'Rajasthali', 'Rangamati Sadar'],
  Pabna: ['Atgharia', 'Bera', 'Bhangura', 'Chatmohar', 'Faridpur', 'Ishwardi', 'Pabna Sadar', 'Santhia', 'Sujanagar'],
  Bogura: ['Adamdighi', 'Bogura Sadar', 'Dhunat', 'Dhupchanchia', 'Gabtali', 'Kahaloo', 'Nandigram', 'Sariakandi', 'Shajahanpur', 'Sherpur', 'Shibganj', 'Sonatala'],
  Tangail: ['Basail', 'Bhuapur', 'Delduar', 'Dhanbari', 'Ghatail', 'Gopalpur', 'Kalihati', 'Madhupur', 'Mirzapur', 'Nagarpur', 'Sakhipur', 'Tangail Sadar'],
  Faridpur: ['Alfadanga', 'Bhanga', 'Boalmari', 'Char Bhadrasan', 'Faridpur Sadar', 'Madhukhali', 'Nagarkanda', 'Sadarpur', 'Saltha'],
  Jashore: ['Abhaynagar', 'Bagherpara', 'Chaugachha', 'Jashore Sadar', 'Jhikargachha', 'Keshabpur', 'Manirampur', 'Sharsha'],
  "Cox's Bazar": ["Chakaria", "Cox's Bazar Sadar", 'Kutubdia', 'Maheshkhali', 'Pekua', 'Ramu', 'Teknaf', 'Ukhia'],
}

/**
 * Flat list of every thana, sorted alphabetically. Used as the `<datalist>`
 * options for the Thana input.
 */
export const BD_THANAS_FLAT = Array.from(
  new Set(Object.values(BD_THANAS_BY_DISTRICT).flat()),
).sort((a, b) => a.localeCompare(b))

/**
 * District list — used by the District dropdown / autocomplete.
 */
export const BD_DISTRICTS = Object.keys(BD_THANAS_BY_DISTRICT).sort((a, b) => a.localeCompare(b))
